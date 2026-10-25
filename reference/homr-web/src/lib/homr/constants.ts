/**
 * The constants of HOMR's constants.py that the port uses, plus the two constants the
 * page-level pipeline needs (SegNet classes and page width).
 *
 * Everything else lives next to the code that uses it.
 */

import { pyRound } from './numeric.ts';

/** SegNet class ids; `stems_rests` is the odd name HOMR uses for the stems. */
export const BACKGROUND_CLASS = 0;
export const STEMS_REST_CLASS = 1;
export const NOTEHEAD_CLASS = 2;
export const CLEFS_KEYS_CLASS = 3;
export const STAFF_CLASS = 4;
export const SYMBOLS_CLASS = 5;
export const NUMBER_OF_CLASSES = 6;

export const NUMBER_OF_LINES_ON_A_STAFF = 5;
export const MAX_NUMBER_OF_LEDGER_LINES = 4;

/** Above this mean Laplacian response a cell counts as noisy. */
export const IMAGE_NOISE_LIMIT = 50;

export const STAFF_LINE_SEGMENT_X_TOLERANCE = 10;

/** Staff.get_at gives up when the closest grid point is further away than this. */
export const STAFF_POSITION_TOLERANCE = 50;

export const MINIMUM_CONNECTIONS_TO_FORM_COMBINED_STAFF = 1;

export const DURATION_OF_QUARTER = 16;

export const MAX_ANGLE_FOR_LINES_TO_BE_PARALLEL = 10;

export const NOTEHEAD_SIZE_RATIO = 1.285714;

export const GRANDSTAFF_X_DISTANCE_THRESHOLD_FACTOR = 5;
export const GRANDSTAFF_Y_OVERLAP_THRESHOLD_FACTOR = 0.5;

export const toleranceForStaffLineDetection = (unitSize: number): number => unitSize / 3;

export const maxLineGapSize = (unitSize: number): number => 5 * unitSize;

export const isShortLine = (unitSize: number): number => unitSize / 5;

export const isShortConnectedLine = (unitSize: number): number => 2 * unitSize;

export const minHeightForBraceRough = (unitSize: number): number => 2 * unitSize;

export const maxWidthForBraceRough = (unitSize: number): number => 3 * unitSize;

export const minHeightForBrace = (unitSize: number): number => 4 * unitSize;

/** Python's round(): ties go to the even neighbour. */
export const toleranceForTouchingClefs = (unitSize: number): number => pyRound(unitSize * 2);

export const toleranceForStaffAtAnyPoint = (_unitSize: number): number => 0;

export const toleranceNoteGrouping = (unitSize: number): number => unitSize;

export const barLineMaxWidth = (unitSize: number): number => 2 * unitSize;

export const barLineMinHeight = (unitSize: number): number => 3 * unitSize;

export const blackSpotRemovalThreshold = (unitSize: number): number => 2 * unitSize;
