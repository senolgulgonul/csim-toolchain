// Symbols LLVM references but never calls in our single-process, in-browser
// use (no fork/exec). Stubbed so wasm-ld can resolve them.
addToLibrary({
  wait4: function(pid, wstatus, options, rusage) { return -1; },
});
