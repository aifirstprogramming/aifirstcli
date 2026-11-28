// Writes a marker between two OSC sequences, then stays alive briefly.
//
// The first OSC ends with ESC-backslash, as OpenTUI's capability probes do. The
// second ends with ESC-backslash ("st") or BEL ("bel"). A matcher that lets an
// OSC run to a later terminator swallows the marker in between.
const mode = process.argv[2] === "bel" ? "bel" : "st";
const closing = mode === "bel" ? "\x1b]0;title\x07" : "\x1b]0;title\x1b\\";
process.stdout.write(`\x1b]66;w=1; \x1b\\DRIVER_MARKER_VISIBLE${closing}`);
await Bun.sleep(3_000);

export {};
