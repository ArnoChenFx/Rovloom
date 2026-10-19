/* Linux x64 原生编译进程：在解释器初始化前固定内核预算，仅暴露有界 IPC。 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>
#include "quickjs.h"
#include "compiler-service.h"

#define HEAP_LIMIT (64UL * 1024 * 1024)
#define FRAME_LIMIT (8UL * 1024 * 1024)
static int initial = 1;
static int compiled = 0;
static int validating = 0;
static uint64_t sequence = 0;
static uint64_t current_sequence = 0;
static volatile sig_atomic_t validation_child = 0;
static unsigned char signal_stack[65536];

/* 不经过 JS：先强杀并回收短命子进程，再由内核销毁当前 VM。 */
static void terminate(int cause) {
    pid_t child = validation_child;
    if (child > 0) {
        kill(child, SIGKILL);
        while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    }
    _exit(cause == SIGALRM ? 142 : 137);
}

/* 内核实时时限不依赖 JS 中断点，正则或编译器卡住仍会终止进程。 */
static void deadline(int enabled) {
    struct itimerval timer = {.it_value = {.tv_sec = enabled ? 2 : 0}};
    if (setitimer(ITIMER_REAL, &timer, NULL)) _exit(110);
}

/* 精确读取固定字节数；截断、I/O 错误与超限不进入 JS。 */
static int receive_all(void *target, size_t length, int allow_eof) {
    unsigned char *out = target;
    size_t offset = 0;
    while (offset < length) {
        ssize_t size = read(STDIN_FILENO, out + offset, length - offset);
        if (size < 0 && errno == EINTR) continue;
        if (size == 0 && offset == 0 && allow_eof) return 0;
        if (size <= 0) _exit(111);
        offset += (size_t)size;
    }
    return 1;
}

/* 返回一个有界 UTF-8 JSON 帧；首次预算包含运行时与服务源码的初始化。 */
static JSValue read_frame(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self; (void)argc; (void)argv;
  for (;;) {
    unsigned char header[4];
    if (!receive_all(header, 1, 1)) return JS_NULL;
    if (!initial) deadline(1);
    initial = 0;
    receive_all(header + 1, 3, 0);
    uint32_t length = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16) |
                      ((uint32_t)header[2] << 8) | header[3];
    if (!length || length > FRAME_LIMIT) _exit(112);
    char *input = malloc((size_t)length + 1);
    if (!input) _exit(113);
    receive_all(input, length, 0);
    input[length] = 0;
    if (sequence > 9007199254740991ULL) _exit(125);
    current_sequence = sequence++;
    if (compiled) {
        /* 单线程 VM 在读取原生请求前分叉；父 VM 永远不接触该请求及 Ajv 数据缓存。 */
        pid_t parent = getpid();
        sigset_t blocked, previous;
        sigemptyset(&blocked);
        sigaddset(&blocked, SIGUSR1);
        sigaddset(&blocked, SIGALRM);
        if (sigprocmask(SIG_BLOCK, &blocked, &previous)) _exit(122);
        pid_t child = fork();
        if (child < 0) _exit(122);
        if (child > 0) {
            validation_child = child;
            if (sigprocmask(SIG_SETMASK, &previous, NULL)) terminate(SIGUSR1);
            explicit_bzero(input, length);
            free(input);
            int status;
            pid_t result;
            siginfo_t observed;
            /* 先观测而不回收，屏蔽终止信号后再清除 PID，避免误杀已复用的 PID。 */
            int waiting;
            do { waiting = waitid(P_PID, child, &observed, WEXITED | WNOWAIT); } while (waiting < 0 && errno == EINTR);
            if (waiting < 0 || sigprocmask(SIG_BLOCK, &blocked, &previous)) terminate(SIGUSR1);
            do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
            validation_child = 0;
            if (sigprocmask(SIG_SETMASK, &previous, NULL)) _exit(124);
            if (result == child && WIFSIGNALED(status) && WTERMSIG(status) == SIGALRM) terminate(SIGALRM);
            if (result != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) _exit(123);
            deadline(0);
            continue;
        }
        validation_child = 0;
        signal(SIGALRM, SIG_DFL);
        signal(SIGUSR1, SIG_DFL);
        if (getppid() != parent || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) _exit(124);
        if (sigprocmask(SIG_SETMASK, &previous, NULL)) _exit(124);
        validating = 1;
        deadline(1);
    }
    JSValue value = JS_NewStringLen(ctx, input, length);
    explicit_bzero(input, length);
    free(input);
    return value;
  }
}

/* 序号在父进程读取帧时推进，分叉的校验 VM 不能复用旧 JS 状态中的序号。 */
static JSValue frame_sequence(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self; (void)argc; (void)argv;
    return JS_NewFloat64(ctx, (double)current_sequence);
}

/* 固定长度前缀避免分隔符歧义，写出完成后才解除本次内核时限。 */
static JSValue write_frame(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self; (void)argc;
    size_t length;
    const char *text = JS_ToCStringLen(ctx, &length, argv[0]);
    if (!text || !length || length > FRAME_LIMIT) _exit(114);
    unsigned char header[4] = {length >> 24, length >> 16, length >> 8, length};
    const void *parts[2] = {header, text};
    const size_t sizes[2] = {4, length};
    for (int part = 0; part < 2; part++) {
        size_t offset = 0;
        while (offset < sizes[part]) {
            ssize_t size = write(STDOUT_FILENO, (const char *)parts[part] + offset, sizes[part] - offset);
            if (size < 0 && errno == EINTR) continue;
            if (size <= 0) _exit(115);
            offset += (size_t)size;
        }
    }
    JS_FreeCString(ctx, text);
    deadline(0);
    if (validating) _exit(0);
    compiled = 1;
    return JS_UNDEFINED;
}

/* 编译器日志不进入 IPC、stderr 或审计，避免把 schema/原生数据带出进程。 */
static JSValue quiet(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)ctx; (void)self; (void)argc; (void)argv;
    return JS_UNDEFINED;
}

/* 从内核随机数建立不可跨进程复用的代次，不生成任何持久凭据。 */
static void install_epoch(JSContext *ctx, JSValue global) {
    unsigned char bytes[16];
    char epoch[33];
    size_t offset = 0;
    while (offset < sizeof(bytes)) {
        ssize_t size = getrandom(bytes + offset, sizeof(bytes) - offset, 0);
        if (size < 0 && errno == EINTR) continue;
        if (size <= 0) _exit(116);
        offset += (size_t)size;
    }
    for (size_t i = 0; i < sizeof(bytes); i++) snprintf(epoch + 2 * i, 3, "%02x", bytes[i]);
    JS_DefinePropertyValueStr(ctx, global, "workerEpoch", JS_NewStringLen(ctx, epoch, 32), JS_PROP_ENUMERABLE);
}

/* 只允许受信父进程启动；死亡和启动竞态都不留下孤儿编译器。 */
int main(int argc, char **argv) {
    char *end = NULL;
    long expected = argc == 2 ? strtol(argv[1], &end, 10) : 0;
    if (expected <= 1 || !end || *end || getppid() != expected) return 117;
    struct rlimit memory = {HEAP_LIMIT, HEAP_LIMIT};
    struct rlimit core = {0, 0};
    if (setrlimit(RLIMIT_AS, &memory) || setrlimit(RLIMIT_CORE, &core)) return 118;
    sigset_t signals;
    sigemptyset(&signals);
    if (sigprocmask(SIG_SETMASK, &signals, NULL)) return 119;
    stack_t alternate = {.ss_sp = signal_stack, .ss_size = sizeof(signal_stack)};
    struct sigaction action = {.sa_handler = terminate, .sa_flags = SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    sigaddset(&action.sa_mask, SIGALRM);
    sigaddset(&action.sa_mask, SIGUSR1);
    if (sigaltstack(&alternate, NULL) || sigaction(SIGALRM, &action, NULL) ||
        sigaction(SIGUSR1, &action, NULL) || prctl(PR_SET_PDEATHSIG, SIGUSR1) || getppid() != expected) return 119;
    signal(SIGPIPE, SIG_DFL);
    int flags = fcntl(STDIN_FILENO, F_GETFL);
    if (flags < 0 || fcntl(STDIN_FILENO, F_SETFL, flags & ~O_NONBLOCK)) return 119;
    deadline(1);
    JSRuntime *runtime = JS_NewRuntime();
    if (!runtime) return 120;
    JS_SetMemoryLimit(runtime, HEAP_LIMIT);
    JS_SetMaxStackSize(runtime, 1024 * 1024);
    JSContext *ctx = JS_NewContext(runtime);
    if (!ctx) { JS_FreeRuntime(runtime); return 120; }
    JSValue global = JS_GetGlobalObject(ctx);
    install_epoch(ctx, global);
    JS_SetPropertyStr(ctx, global, "readFrame", JS_NewCFunction(ctx, read_frame, "readFrame", 0));
    JS_SetPropertyStr(ctx, global, "frameSequence", JS_NewCFunction(ctx, frame_sequence, "frameSequence", 0));
    JS_SetPropertyStr(ctx, global, "writeFrame", JS_NewCFunction(ctx, write_frame, "writeFrame", 1));
    JSValue logger = JS_NewObject(ctx);
    const char *names[] = {"log", "error", "warn"};
    for (int i = 0; i < 3; i++) JS_SetPropertyStr(ctx, logger, names[i], JS_NewCFunction(ctx, quiet, names[i], 0));
    JS_SetPropertyStr(ctx, global, "console", logger);
    JSValue result = JS_Eval(ctx, (const char *)compiler_service, sizeof(compiler_service) - 1,
                             "rovloom-schema-compiler", JS_EVAL_TYPE_GLOBAL);
    int failed = JS_IsException(result);
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, global);
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
    return failed ? 121 : 0;
}
