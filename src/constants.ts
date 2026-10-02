export const STATE_MAX_CHARS = 80_000;
export const TEST_SOURCE_MAX_BYTES = STATE_MAX_CHARS * 16;
export const SELECT_FILE_SHARE = 0.8;
export const ASK_NOTE_MAX_CHARS = 8_000;
export const ASK_MAX_FILES = 20;
export const ASK_TIMEOUT_S = 60;
export const ASK_TIMEOUT_MAX_S = 300;
export const OUTPUT_REPEAT_MIN = 5;
export const OUTPUT_CHUNK_CHARS = 2_500;
export const OUTPUT_FIND_MAX_CALLS = 40;
export const OUTPUT_HEAD_SHARE = 0.05;
export const OUTPUT_TAIL_SHARE = 0.15;
// Unmeasured admission bound for each command output file; never truncate it silently.
export const OUTPUT_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const OUTPUT_LINE_MAX_CHARS = 8_192;
export const OUTPUT_SHAPE_MAX_COUNT = 2_048;
export const OUTPUT_FAILURE_WINDOW_LINES = 20;
export const CHOICE_MAX_OPTIONS = 255;
export const MAX_FILES = 255;
export const FILE_MAX_KB = STATE_MAX_CHARS / 1_000;
export const SCORE_MIN_LEVELS = 2;
export const SCORE_MAX_LEVELS = 10;
export const TIMEOUT_MS = 10_000;
export const UNIT_MAX_CHARS = 6_000;
export const UNIT_CONTEXT_LINES = 8;
export const SELECT_MIN = 0.5;
export const BAND_BOOL_GRAY_A = 0.2;
export const BAND_BOOL_YES_MIN = 1 - BAND_BOOL_GRAY_A;
export const ORDER_REVERSE_BELOW = 0.85;
export const ORDER_DISAGREE_MIN = 0.1;
export const BAND_CHOICE_VERDICT_MIN = ORDER_REVERSE_BELOW;
export const CANNOT_TELL_MIN = 0.3;
export const REQUEST_MAX_TOKENS = 60_000;
export const RATE_PER_SECOND = 8;
export const CONCURRENCY = 8;
export const REQUEST_ATTEMPTS = 3;
export const RETRY_BASE_MS = 500;
export const RETRY_MAX_MS = 5_000;
export const HTTP_ERROR_MAX_CHARS = 300;
export const QUESTION_TOKENS = 1 / 3.3;
export const STATE_TOKENS = 0.283;
export const REQUEST_BASE_TOKENS = 456;
export const FLAG_MIN = 0.7;
export const DOCS_CHECK_MIN = 0.2;
export const DOCS_MAX_SECTIONS = 40;
export const HOOK_BUDGET_MS = 15_000;
/** Progressive collection time bound, not a coverage or wall-time guarantee. */
export const DOCS_COLLECT_BUDGET_MS = 750;
export const DOCS_NAME_MAX_FILES = 32;
/** Initial per-anchor traversal bound; shared edge cache remains unbounded. */
export const DOCS_ANCHOR_MAX_FILES = 32;
export const WITNESS_LURE_MAX = 0.15;
/** Small coverage decoys only; risk and large-witness policies remain unchanged. */
export const COVERAGE_WITNESS_LURE_MAX = 0.2;
export const WITNESS_LARGE_LURE_MAX = 0.25;
export const WITNESS_LARGE_CHARS = 13_000;
export const WITNESS_ETALON_MIN = 0.7;
export const WITNESS_AUTO_MIN_CELLS = 8;
export const CLOSURE_MAX_CHARS = 20_000;
export const CALLER_DISPLAY_MAX_SPANS = 8;
export const LIMIT_DISPLAY_MAX_PATHS = 4;
export const DOCS_DISPLAY_MAX_SECTIONS = 5;
export const FIND_NAME_CANDIDATES = 128;
export const FIND_NAME_BATCH = 64;
export const FIND_FILES_READ = 20;
export const FIND_READ_PER_CALL = 5;
export const FIND_EXCERPT_CHARS = 3_000;
export const FIND_POINTER_EXCERPT_CHARS = 1_500;
export const FIND_POINTER_MAX = 8;
export const FIND_NAME_GUARD_MIN = 0.9;
export const FIND_CONFIRM_MIN = 0.8;
export const FIND_GOAL_MIN_WORDS = 5;
export const FIND_QUICK_CANDIDATES = 32;
export const FIND_QUICK_READ = 8;
export const FIND_THOROUGH_CANDIDATES = 256;
export const FIND_THOROUGH_READ = 40;
export const FIND_EXCERPT_HEAD_CHARS = 1_000;
export const FIND_CONTENT_MIN = 0.5;
export const FIND_NAME_GUARD_TOP = 3;
export const FIND_PATH_WEIGHT = 3;
export const FIND_GREP_PAGE_SIZE = 1024;
export const FIND_READ_CHUNK_BYTES = 16_384;
export const LOCATE_MIN_KB = 19;
export const LOCATE_VERDICT_MIN = 0.7;
export const LOCATE_GRAY_MIN = 0.4;
export const LOCATE_SHRINK_TOP = 3;
export const LOCATE_SECTION_MAX_LINES = 150;
export const LOCATE_SECTION_MIN_LINES = 8;
export const LOCATE_WINDOW_LINES = 80;
export const LOCATE_LABEL_MAX_CHARS = 120;
export const LOCATE_WHOLE_MAX_CHARS = STATE_MAX_CHARS * 4;
export const LOCATE_WHOLE_MAX_BYTES = LOCATE_WHOLE_MAX_CHARS * 4;
export const LOCATE_READ_BUFFER_BYTES = 64 * 1024;
// Unmeasured engineering bound: leaves room for multi-window refinement and JSON metadata.
export const LOCATE_WINDOW_MAX_SERIALIZED_CHARS = STATE_MAX_CHARS / 4;
// Keep SHA-256 IDs plus options below Windows' command-line limit.
export const GIT_BLOB_BATCH_SIZE = 400;
export const RUNNER_PACKAGE_MAX_BYTES = 64 * 1024;

// ADR 0001: allowed local dependencies, including erased type imports.
export const IMPORT_LAYERS = {
  core: ["core", "constants.ts", "result.ts", "jev/types.ts"],
  presets: ["presets", "core", "constants.ts", "result.ts", "jev/types.ts"],
  adapters: ["adapters", "core", "constants.ts", "result.ts", "jev/types.ts"],
  jev: ["jev", "core", "constants.ts", "result.ts"],
  texts: ["texts", "constants.ts", "presets"],
  "constants.ts": [],
  "result.ts": [],
} as const;
