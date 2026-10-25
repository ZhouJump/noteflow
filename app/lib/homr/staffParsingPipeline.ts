/**
 * `staff_parsing.py` minus the geometry: pick the systems, run every staff through the
 * transformer, and clean up each voice.
 *
 * This sits apart from `staffParsing.ts` because it is the only part that needs ONNX
 * Runtime sessions; the geometry there stays importable from plain Node scripts such as
 * `scripts/check-dewarp.mjs`.
 */

import type { MultiStaff, Staff } from './model'
import { predictStaffSymbols, type TransformerSessions } from './staff2score'
import {
  prepareStaffImage,
  StaffRegions,
  type PrepareStaffOptions,
  type PreparedStaff
} from './staffParsing'
import type { GrayImage } from './staffDewarping'
import { EncodedSymbol, removeDuplicatedSymbols } from './vocabulary'

/** `_have_all_the_same_number_of_staffs` */
function haveAllTheSameNumberOfStaffs(staffs: MultiStaff[]): boolean {
  return staffs.every(staff => staff.staffs.length === staffs[0].staffs.length)
}

/**
 * `_is_close_to_image_top_or_bottom`. HOMR measures the distance to the bottom as
 * `image.shape[0] - staff.max_x`, i.e. the image height minus an x coordinate. That is
 * dimensionally wrong, but it only makes a system at the bottom edge look "not close",
 * which leaves such a system in place. Kept so the same systems get dropped.
 */
function isCloseToImageTopOrBottom(staff: MultiStaff, image: GrayImage): boolean {
  const tolerance = 50
  const distances = staff.staffs.map(single =>
    Math.min(single.minX, image.height - single.maxX)
  )
  return Math.min(...distances) < tolerance
}

/** `_ensure_same_number_of_staffs`: drop the odd system at a page edge, else split all. */
export function ensureSameNumberOfStaffs(staffs: MultiStaff[], image: GrayImage): MultiStaff[] {
  if (haveAllTheSameNumberOfStaffs(staffs)) return staffs
  if (staffs.length > 2) {
    if (
      isCloseToImageTopOrBottom(staffs[0], image)
      && haveAllTheSameNumberOfStaffs(staffs.slice(1))
    ) {
      return staffs.slice(1)
    }
    if (
      isCloseToImageTopOrBottom(staffs[staffs.length - 1], image)
      && haveAllTheSameNumberOfStaffs(staffs.slice(0, -1))
    ) {
      return staffs.slice(0, -1)
    }
  }
  const result: MultiStaff[] = []
  for (const staff of staffs) result.push(...staff.breakApart())
  return result.sort((a, b) => a.staffs[0].minY - b.staffs[0].minY)
}

/** `_get_number_of_voices`: one voice per staff row of a system, grand staff included. */
export function getNumberOfVoices(staffs: MultiStaff[]): number {
  return staffs[0].staffs.length
}

/** One staff that went through the transformer, kept for the overlay. */
export interface ParsedStaff {
  /** Position in the parse order, the same numbering HOMR logs. */
  index: number
  voice: number
  /** The staff's row within its system, `staff_index` in `parse_staffs`. */
  systemIndex: number
  /** The detected staff in page coordinates, before any crop or scaling. */
  staff: Staff
  prepared: PreparedStaff
  symbols: EncodedSymbol[]
}

export interface ParsedVoices {
  /** One symbol list per voice, cleaned up and ready for the MusicXML writer. */
  voices: EncodedSymbol[][]
  /** The staff-level detail behind `voices`, in the order it was recognised. */
  staffs: ParsedStaff[]
}

export interface ParseStaffsOptions extends PrepareStaffOptions {
  onStaffDone?: (staff: ParsedStaff, done: number, total: number) => void
}

/**
 * `parse_staffs`: crop, recognise and clean up one voice at a time.
 *
 * The voices keep HOMR's order: an outer loop over the staff rows of a system and an
 * inner loop down the systems, so voice 0 reads every upper staff before voice 1 reads
 * the lower ones. A `newline` symbol separates the systems of a voice.
 */
export async function parseStaffs(
  staffs: MultiStaff[],
  staffImage: GrayImage,
  sessions: TransformerSessions,
  options: ParseStaffsOptions = {}
): Promise<ParsedVoices> {
  const kept = ensureSameNumberOfStaffs(staffs, staffImage)
  const numberOfVoices = getNumberOfVoices(kept)
  const regions = new StaffRegions(kept)
  const total = kept.length * numberOfVoices
  const parsedStaffs: ParsedStaff[] = []
  const voices: EncodedSymbol[][] = []
  let index = 0
  for (let voice = 0; voice < numberOfVoices; voice += 1) {
    const staffsForVoice = kept.map(multiStaff => multiStaff.staffs[voice])
    const resultForVoice: EncodedSymbol[] = []
    for (let systemIndex = 0; systemIndex < staffsForVoice.length; systemIndex += 1) {
      const staff = staffsForVoice[systemIndex]
      const prepared = prepareStaffImage(index, staff, staffImage, regions, options)
      const predicted = await predictStaffSymbols(prepared.canvas, sessions)
      // `predict_best`: a staff outside a grand staff has no lower voice of its own.
      const symbols = prepared.transformedStaff.isGrandStaff
        ? predicted
        : predicted.filter(symbol => symbol.position !== 'lower')
      // Ids stay with the symbol through the clean-up and the writer, so the UI can
      // point at the note the decoder looked at. The scheme matches the localisation
      // export: `s<staff index>-<symbol index>`.
      for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
        symbols[symbolIndex].id = `s${index}-${symbolIndex}`
      }
      const entry: ParsedStaff = { index, voice, systemIndex, staff, prepared, symbols }
      parsedStaffs.push(entry)
      index += 1
      options.onStaffDone?.(entry, parsedStaffs.length, total)
      if (symbols.length === 0) continue
      resultForVoice.push(...symbols, new EncodedSymbol('newline'))
    }
    voices.push(removeDuplicatedSymbols(resultForVoice))
  }
  return { voices, staffs: parsedStaffs }
}
