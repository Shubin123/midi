#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#ifdef NATIVE
#include <stdio.h>
#endif

extern void *objc_autoreleasePoolPush(void);
extern void objc_autoreleasePoolPop(void *);
extern int __cxa_guard_acquire(uint64_t *);
extern void __cxa_guard_release(uint64_t *);

static pthread_mutex_t mutex;
static pthread_key_t key;
static pthread_t parent;
static int entered;
static int destructors;
static int counter;
static uint64_t guard;
static int initialized;
static pthread_cond_t condition = PTHREAD_COND_INITIALIZER;
static int waiting;
static int released;

static int context(uint64_t pattern, int rounding) {
#ifdef __x86_64__
 unsigned initial_mxcsr, current_mxcsr;
 unsigned short initial_control, current_control;
 uint64_t actual;
 __asm__ volatile("stmxcsr %0; fnstcw %1" : "=m"(initial_mxcsr), "=m"(initial_control));
 unsigned requested_mxcsr = (initial_mxcsr & ~0x6000u) | ((unsigned)rounding << 13);
 unsigned short requested_control = (initial_control & ~0xc00u) | (rounding << 10);
 __asm__ volatile("ldmxcsr %0; fldcw %1; movq %2, %%xmm14" : : "m"(requested_mxcsr), "m"(requested_control), "r"(pattern) : "xmm14");
 for (volatile int iteration = 0; iteration < 2000; iteration++) __asm__ volatile("pause" : : : "memory");
 __asm__ volatile("movq %%xmm14, %0; stmxcsr %1; fnstcw %2" : "=r"(actual), "=m"(current_mxcsr), "=m"(current_control));
 __asm__ volatile("ldmxcsr %0; fldcw %1" : : "m"(initial_mxcsr), "m"(initial_control));
 return actual == pattern && current_mxcsr == requested_mxcsr && current_control == requested_control;
#else
 return pattern != 0 && rounding != 0;
#endif
}

static void destroy(void *value) {
 __atomic_add_fetch(&destructors, 1, __ATOMIC_SEQ_CST);
 if ((uintptr_t)value > 1) pthread_setspecific(key, (void *)((uintptr_t)value - 1));
}

static void *worker(void *argument) {
 uintptr_t index = (uintptr_t)argument;
 unsigned checks = 0;
 void *pool = objc_autoreleasePoolPush();
 if (!pthread_getspecific(key)) checks |= 1;
 if (!pthread_equal(pthread_self(), parent)) checks |= 2;
 if (!errno) checks |= 4;
 errno = 82;
 pthread_setspecific(key, argument);
 if (pthread_mutex_unlock(&mutex) == EPERM) checks |= 8;
 if (pthread_mutex_trylock(&mutex) == EBUSY) checks |= 16;
 __atomic_add_fetch(&entered, 1, __ATOMIC_SEQ_CST);
 if (context(0xfedcba9876543200ull | index, (int)index)) checks |= 32;
 if (errno == 82 && pthread_getspecific(key) == argument) checks |= 64;
 if (__cxa_guard_acquire(&guard)) {
  context(0xabcdef0123456789ull, 1); initialized++;
  __cxa_guard_release(&guard);
 }
 pthread_mutex_lock(&mutex);
 __atomic_add_fetch(&waiting, 1, __ATOMIC_SEQ_CST);
 while (!released) pthread_cond_wait(&condition, &mutex);
 pthread_mutex_unlock(&mutex);
 int success = 1;
 for (int iteration = 0; iteration < 200; iteration++) {
  if (pthread_mutex_lock(&mutex)) success = 0;
  counter++;
  if (pthread_mutex_unlock(&mutex)) success = 0;
 }
 if (success) checks |= 128;
 objc_autoreleasePoolPop(pool);
 void *result = (void *)(0xfedc000000000000ull | ((uint64_t)checks << 8) | index);
 if (index == 2) pthread_exit(result);
 return result;
}

unsigned probe(void) {
 unsigned checks = 0;
 void *pool = objc_autoreleasePoolPush();
 pthread_t first, second;
 pthread_mutexattr_t attribute;
 void *first_result = 0, *second_result = 0;
 parent = pthread_self();
 pthread_mutexattr_init(&attribute); pthread_mutexattr_settype(&attribute, PTHREAD_MUTEX_ERRORCHECK);
 pthread_mutex_init(&mutex, &attribute); pthread_mutexattr_destroy(&attribute);
 if (!pthread_key_create(&key, destroy)) checks |= 1;
 pthread_setspecific(key, (void *)9);
 errno = 71;
 if (!pthread_mutex_lock(&mutex)) checks |= 2;
 if (!pthread_create(&first, 0, worker, (void *)3)) checks |= 4;
 if (!pthread_create(&second, 0, worker, (void *)2)) checks |= 8;
 while (__atomic_load_n(&entered, __ATOMIC_SEQ_CST) != 2) {}
 if (context(0x0123456789abcdefull, 3)) checks |= 16;
 if (!pthread_mutex_unlock(&mutex)) checks |= 32;
 while (__atomic_load_n(&waiting, __ATOMIC_SEQ_CST) != 2) {}
 pthread_mutex_lock(&mutex); released = 1;
 pthread_cond_signal(&condition); pthread_cond_broadcast(&condition); pthread_mutex_unlock(&mutex);
 if (!pthread_join(first, &first_result) && !pthread_join(second, &second_result)) checks |= 64;
 if ((uintptr_t)first_result == 0xfedc00000000ff03ull && (uintptr_t)second_result == 0xfedc00000000ff02ull) checks |= 128;
 if (counter == 400 && destructors == 5 && initialized == 1) checks |= 256;
 if (errno == 71 && pthread_getspecific(key) == (void *)9) checks |= 512;
 if (!pthread_key_delete(key) && !pthread_mutex_destroy(&mutex) && !pthread_cond_destroy(&condition)) checks |= 1024;
 objc_autoreleasePoolPop(pool);
 return checks;
}

#ifdef NATIVE
int main(void) {
 int policy;
 struct sched_param parameter;
 pthread_getschedparam(pthread_self(), &policy, &parameter);
 printf("%u %d\n", probe(), (policy << 16) | parameter.sched_priority); return 0;
}
#endif
