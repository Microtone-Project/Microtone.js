/* Crash reports — see crashlog.h. */
#include "crashlog.h"

#include <stdio.h>
#include <string.h>

static char g_version[64];

#ifdef _WIN32

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dbghelp.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>

static wchar_t g_dir[MAX_PATH];
static LPTOP_LEVEL_EXCEPTION_FILTER g_previous;
static volatile LONG g_reported;

typedef BOOL(WINAPI *MiniDumpWriteDump_t)(HANDLE, DWORD, HANDLE, MINIDUMP_TYPE, PMINIDUMP_EXCEPTION_INFORMATION,
                                          PMINIDUMP_USER_STREAM_INFORMATION, PMINIDUMP_CALLBACK_INFORMATION);
typedef DWORD(WINAPI *SymSetOptions_t)(DWORD);
typedef BOOL(WINAPI *SymInitialize_t)(HANDLE, PCSTR, BOOL);
typedef BOOL(WINAPI *SymFromAddr_t)(HANDLE, DWORD64, PDWORD64, PSYMBOL_INFO);
typedef BOOL(WINAPI *SymGetLineFromAddr64_t)(HANDLE, DWORD64, PDWORD, PIMAGEHLP_LINE64);

/* The frames of the report being written, for the symbol pass after it. */
static void *g_frames[64];
static int g_nframes;

static void put(HANDLE f, const char *s)
{
    DWORD n;
    WriteFile(f, s, (DWORD)strlen(s), &n, NULL);
}

/** "module+0xoffset" for an address in the process. */
static void where(const void *addr, char *out, size_t cap)
{
    HMODULE m = NULL;
    wchar_t path[MAX_PATH];
    char name[MAX_PATH];
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCWSTR)addr, &m) &&
        GetModuleFileNameW(m, path, MAX_PATH) > 0) {
        const wchar_t *base = wcsrchr(path, L'\\');
        WideCharToMultiByte(CP_UTF8, 0, base != NULL ? base + 1 : path, -1, name, (int)sizeof name, NULL, NULL);
        snprintf(out, cap, "%s+0x%llx", name, (unsigned long long)((uintptr_t)addr - (uintptr_t)m));
    } else {
        snprintf(out, cap, "0x%llx", (unsigned long long)(uintptr_t)addr);
    }
}

static const char *code_name(DWORD code)
{
    switch (code) {
    case EXCEPTION_ACCESS_VIOLATION: return "access violation";
    case EXCEPTION_STACK_OVERFLOW: return "stack overflow";
    case EXCEPTION_INT_DIVIDE_BY_ZERO: return "integer division by zero";
    case EXCEPTION_ILLEGAL_INSTRUCTION: return "illegal instruction";
    case EXCEPTION_IN_PAGE_ERROR: return "in-page error";
    case EXCEPTION_PRIV_INSTRUCTION: return "privileged instruction";
    case 0xE06D7363: return "C++ exception";
    case 0xC0000409: return "stack buffer overrun / fast fail";
    case 0xC0000374: return "heap corruption";
    default: return "exception";
    }
}

static void report(EXCEPTION_POINTERS *ep, const char *why)
{
    SYSTEMTIME t;
    wchar_t name[MAX_PATH + 64];
    char line[512], at[MAX_PATH + 32];
    HANDLE f;
    int i;
    if (InterlockedExchange(&g_reported, 1) != 0 || g_dir[0] == 0) return;  // one report per death
    GetLocalTime(&t);
    _snwprintf(name, sizeof name / sizeof name[0], L"%ls\\crash-%04d%02d%02d-%02d%02d%02d.txt", g_dir, t.wYear, t.wMonth,
               t.wDay, t.wHour, t.wMinute, t.wSecond);
    f = CreateFileW(name, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    snprintf(line, sizeof line, "Microtone %s stopped: %s\r\nthread %lu, %04d-%02d-%02d %02d:%02d:%02d\r\n", g_version,
             why, GetCurrentThreadId(), t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    put(f, line);
    if (ep != NULL && ep->ExceptionRecord != NULL) {
        const EXCEPTION_RECORD *r = ep->ExceptionRecord;
        where(r->ExceptionAddress, at, sizeof at);
        snprintf(line, sizeof line, "%s 0x%08lx at %s\r\n", code_name(r->ExceptionCode), r->ExceptionCode, at);
        put(f, line);
        if (r->ExceptionCode == EXCEPTION_ACCESS_VIOLATION && r->NumberParameters >= 2) {
            snprintf(line, sizeof line, "  %s address 0x%llx\r\n",
                     r->ExceptionInformation[0] == 0 ? "reading" : r->ExceptionInformation[0] == 1 ? "writing" : "executing",
                     (unsigned long long)r->ExceptionInformation[1]);
            put(f, line);
        }
    }
    put(f, "stack:\r\n");
#if defined(_M_X64) || defined(__x86_64__)
    if (ep != NULL && ep->ContextRecord != NULL) {
        /* The faulting thread's own frames, unwound from the context the
         * fault left (the handler's frames are not in it). */
        CONTEXT c = *ep->ContextRecord;
        for (i = 0; i < 64 && c.Rip != 0; i++) {
            DWORD64 image = 0, frame = 0;
            PVOID data = NULL;
            PRUNTIME_FUNCTION fn;
            where((const void *)(uintptr_t)c.Rip, at, sizeof at);
            snprintf(line, sizeof line, "  #%02d %s\r\n", i, at);
            put(f, line);
            g_frames[g_nframes++] = (void *)(uintptr_t)c.Rip;
            fn = RtlLookupFunctionEntry(c.Rip, &image, NULL);
            if (fn == NULL) {  // a leaf: the return address is at the stack pointer
                if (c.Rsp == 0 || IsBadReadPtr((const void *)(uintptr_t)c.Rsp, 8)) break;
                c.Rip = *(DWORD64 *)(uintptr_t)c.Rsp;
                c.Rsp += 8;
            } else {
                RtlVirtualUnwind(UNW_FLAG_NHANDLER, image, c.Rip, fn, &c, &data, &frame, NULL);
            }
        }
    } else
#endif
    {
        void *frames[64];
        const USHORT n = RtlCaptureStackBackTrace(1, 64, frames, NULL);
        for (i = 0; i < n; i++) {
            where(frames[i], at, sizeof at);
            snprintf(line, sizeof line, "  #%02d %s\r\n", i, at);
            put(f, line);
            g_frames[g_nframes++] = frames[i];
        }
    }
    CloseHandle(f);

    /* The minidump: every thread's stack, for a debugger with the .pdb. */
    {
        HMODULE dbghelp = LoadLibraryW(L"dbghelp.dll");
        MiniDumpWriteDump_t dump = dbghelp != NULL ? (MiniDumpWriteDump_t)(void (*)(void))GetProcAddress(dbghelp, "MiniDumpWriteDump") : NULL;
        if (dump != NULL) {
            const size_t len = wcslen(name);
            HANDLE d;
            wcscpy(name + len - 3, L"dmp");
            d = CreateFileW(name, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (d != INVALID_HANDLE_VALUE) {
                MINIDUMP_EXCEPTION_INFORMATION mei;
                mei.ThreadId = GetCurrentThreadId();
                mei.ExceptionPointers = ep;
                mei.ClientPointers = FALSE;
                dump(GetCurrentProcess(), GetCurrentProcessId(), d,
                     (MINIDUMP_TYPE)(MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules | MiniDumpWithIndirectlyReferencedMemory),
                     ep != NULL ? &mei : NULL, NULL, NULL);
                CloseHandle(d);
            }
            wcscpy(name + len - 3, L"txt");
        }

        /* Last, and riskiest, the frames' names: from the .pdb beside each
         * module where there is one (microtone.pdb ships beside the exe).
         * The plain report above is already on disk if this goes wrong. */
        if (dbghelp != NULL) {
            SymSetOptions_t setOptions = (SymSetOptions_t)(void (*)(void))GetProcAddress(dbghelp, "SymSetOptions");
            SymInitialize_t init = (SymInitialize_t)(void (*)(void))GetProcAddress(dbghelp, "SymInitialize");
            SymFromAddr_t fromAddr = (SymFromAddr_t)(void (*)(void))GetProcAddress(dbghelp, "SymFromAddr");
            SymGetLineFromAddr64_t lineOf = (SymGetLineFromAddr64_t)(void (*)(void))GetProcAddress(dbghelp, "SymGetLineFromAddr64");
            HANDLE self = GetCurrentProcess();
            if (setOptions != NULL && init != NULL && fromAddr != NULL) {
                setOptions(SYMOPT_UNDNAME | SYMOPT_LOAD_LINES | SYMOPT_DEFERRED_LOADS | SYMOPT_FAIL_CRITICAL_ERRORS);
                if (init(self, NULL, TRUE)) {
                    f = CreateFileW(name, FILE_APPEND_DATA, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
                    if (f != INVALID_HANDLE_VALUE) {
                        static char buf[sizeof(SYMBOL_INFO) + 256];
                        put(f, "symbols:\r\n");
                        for (i = 0; i < g_nframes; i++) {
                            SYMBOL_INFO *sym = (SYMBOL_INFO *)buf;
                            DWORD64 off = 0;
                            DWORD col = 0;
                            IMAGEHLP_LINE64 ln;
                            memset(buf, 0, sizeof buf);
                            sym->SizeOfStruct = sizeof(SYMBOL_INFO);
                            sym->MaxNameLen = 255;
                            memset(&ln, 0, sizeof ln);
                            ln.SizeOfStruct = sizeof ln;
                            if (!fromAddr(self, (DWORD64)(uintptr_t)g_frames[i], &off, sym)) continue;
                            if (lineOf != NULL && lineOf(self, (DWORD64)(uintptr_t)g_frames[i], &col, &ln) && ln.FileName != NULL) {
                                snprintf(line, sizeof line, "  #%02d %s+0x%llx  %s:%lu\r\n", i, sym->Name,
                                         (unsigned long long)off, ln.FileName, (unsigned long)ln.LineNumber);
                            } else {
                                snprintf(line, sizeof line, "  #%02d %s+0x%llx\r\n", i, sym->Name, (unsigned long long)off);
                            }
                            put(f, line);
                        }
                        CloseHandle(f);
                    }
                }
            }
        }
    }
}

static LONG WINAPI on_exception(EXCEPTION_POINTERS *ep)
{
    report(ep, "a fault");
    return g_previous != NULL ? g_previous(ep) : EXCEPTION_CONTINUE_SEARCH;
}

static void on_abort(int sig)
{
    (void)sig;
    report(NULL, "abort()");
}

static void on_purecall(void)
{
    report(NULL, "a pure virtual call");
    abort();
}

static void on_invalid_parameter(const wchar_t *e, const wchar_t *fn, const wchar_t *file, unsigned l, uintptr_t r)
{
    (void)e; (void)fn; (void)file; (void)l; (void)r;
    report(NULL, "an invalid parameter to the C runtime");
    abort();
}

void mt_crashlog_install(const char *dir, const char *version)
{
    snprintf(g_version, sizeof g_version, "%s", version != NULL ? version : "");
    if (MultiByteToWideChar(CP_UTF8, 0, dir, -1, g_dir, MAX_PATH) == 0) g_dir[0] = 0;
    if (g_dir[0] != 0) CreateDirectoryW(g_dir, NULL);
    /* Called again after something else (Chromium) may have put its own in:
     * ours goes first, then theirs. */
    {
        LPTOP_LEVEL_EXCEPTION_FILTER old = SetUnhandledExceptionFilter(on_exception);
        if (old != on_exception) g_previous = old;
    }
    signal(SIGABRT, on_abort);
#ifdef _MSC_VER
    _set_purecall_handler(on_purecall);
    _set_invalid_parameter_handler(on_invalid_parameter);
#else
    (void)on_purecall;
    (void)on_invalid_parameter;
#endif
}

void mt_crashlog_report(const char *why) { report(NULL, why); }

#else  /* POSIX: Linux, macOS */

#include <execinfo.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static char g_dir[1024];
static volatile sig_atomic_t g_reported;

static void put(int fd, const char *s)
{
    ssize_t r = write(fd, s, strlen(s));
    (void)r;
}

static void report_to(const char *why, int sig)
{
    char path[1100], line[256];
    void *frames[64];
    int fd, n;
    time_t now;
    if (g_reported || g_dir[0] == 0) return;
    g_reported = 1;
    now = time(NULL);
    snprintf(path, sizeof path, "%s/crash-%ld.txt", g_dir, (long)now);  // no localtime: not signal-safe
    fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return;
    snprintf(line, sizeof line, "Microtone %s stopped: %s", g_version, why);
    put(fd, line);
    if (sig != 0) {
        snprintf(line, sizeof line, " (signal %d)", sig);
        put(fd, line);
    }
    put(fd, "\nstack:\n");
    n = backtrace(frames, 64);
    backtrace_symbols_fd(frames, n, fd);
    close(fd);
}

static void on_signal(int sig)
{
    report_to(sig == SIGABRT ? "abort()" : "a fault", sig);
    signal(sig, SIG_DFL);
    raise(sig);
}

void mt_crashlog_install(const char *dir, const char *version)
{
    static char altstack[64 * 1024];
    stack_t ss;
    struct sigaction sa;
    void *warm[1];
    const int sigs[] = {SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT};
    size_t i;
    snprintf(g_version, sizeof g_version, "%s", version != NULL ? version : "");
    snprintf(g_dir, sizeof g_dir, "%s", dir != NULL ? dir : "");
    if (g_dir[0] != 0) mkdir(g_dir, 0755);
    backtrace(warm, 1);  // loads what backtrace needs now, not in the handler
    /* A stack of its own, so a stack overflow still gets a report. */
    ss.ss_sp = altstack;
    ss.ss_size = sizeof altstack;
    ss.ss_flags = 0;
    sigaltstack(&ss, NULL);
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sa.sa_flags = SA_ONSTACK;
    sigemptyset(&sa.sa_mask);
    for (i = 0; i < sizeof sigs / sizeof sigs[0]; i++) sigaction(sigs[i], &sa, NULL);
}

void mt_crashlog_report(const char *why) { report_to(why, 0); }

#endif
