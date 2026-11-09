#import <Foundation/Foundation.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>

unsigned probe_operation_queue(void) {
 NSOperationQueue *main = [NSOperationQueue mainQueue];
 return main != nil && [NSOperationQueue currentQueue] == main && [NSOperationQueue mainQueue] == main;
}

void *probe_operation_queue_worker(void *main) {
 return (void *)(uintptr_t)([NSOperationQueue currentQueue] == nil && [NSOperationQueue mainQueue] == main);
}

#ifdef NATIVE
int main(void) {
 @autoreleasepool {
  printf("%u\n", probe_operation_queue());
  pthread_t thread; void *result = NULL;
  if (pthread_create(&thread, NULL, probe_operation_queue_worker, [NSOperationQueue mainQueue])) return 1;
  if (pthread_join(thread, &result)) return 1;
  printf("%lu\n", (unsigned long)result);
 }
 return 0;
}
#endif
