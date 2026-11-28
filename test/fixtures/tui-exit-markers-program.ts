// Prints two markers in one write and exits at once, like a program whose last
// lines arrive together with its exit. A driver that stops reading at exit
// before checking what it already captured misses the second marker.
process.stdout.write("FIRST_EXIT_MARKER\r\nSECOND_EXIT_MARKER\r\n");

export {};
