/* Crash reports, for builds nobody here can run under a debugger (a friend's
 * Windows machine, CI's Mac): when the process dies of a fault, an abort or an
 * uncaught exception, a text report goes into a folder — what happened, the
 * faulting module and offset, the faulting thread's stack as module+offset
 * frames — and on Windows a minidump beside it.
 *
 * The frames are module+offset because that is what the build's debug files
 * (the CI's .pdb artifact, `llvm-symbolizer --obj=microtone.exe 0x<offset>`)
 * turn back into functions and lines. Plain C, and nothing in the handlers
 * allocates: by then the heap may be what broke. */
#ifndef MICROTONE_CRASHLOG_H
#define MICROTONE_CRASHLOG_H

#ifdef __cplusplus
extern "C" {
#endif

/** Reports go into `dir` (UTF-8, made if missing); `version` heads each. */
void mt_crashlog_install(const char *dir, const char *version);

/** A report now, for a death the handlers do not see (std::terminate). */
void mt_crashlog_report(const char *why);

#ifdef __cplusplus
}
#endif

#endif
