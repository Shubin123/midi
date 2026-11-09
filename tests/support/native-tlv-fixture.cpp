#include <pthread.h>
#include <stdint.h>

static thread_local int counter = 41;
static thread_local int zeroed;
static thread_local long pair[2] = { 7, 9 };

static void *worker(void *) {
 counter += 1; zeroed = 5; pair[1] = 100;
 return (void *)(intptr_t)(counter * 1000 + zeroed * 10 + pair[0]);
}

extern "C" int probe_tlv(void) {
 counter = 500; zeroed = 3; pair[0] = 1;
 pthread_t thread; void *result = nullptr;
 if (pthread_create(&thread, nullptr, worker, nullptr) || pthread_join(thread, &result)) return -1;
 int ok = 0;
 ok |= (intptr_t)result == 42 * 1000 + 5 * 10 + 7 ? 1 : 0;
 ok |= counter == 500 ? 2 : 0;
 ok |= zeroed == 3 ? 4 : 0;
 ok |= pair[0] == 1 && pair[1] == 9 ? 8 : 0;
 return ok;
}

#ifdef NATIVE
#include <stdio.h>
int main() { printf("%d\n", probe_tlv()); return 0; }
#endif
