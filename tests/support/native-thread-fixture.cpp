#include <chrono>
#include <cstddef>
#include <cerrno>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <mutex>
#include <new>
#include <pthread.h>
#include <sys/mount.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <unistd.h>
#ifdef NATIVE
#include <cstdio>
#endif

static std::mutex mutex;
static std::condition_variable condition;
static bool waiting;
static bool released;
static int result;

static_assert(std::chrono::steady_clock::period::den == 1000000000, "steady clock uses nanoseconds");
static_assert(std::chrono::system_clock::period::den == 1000000, "Darwin system clock uses microseconds");
static_assert(sizeof(struct statfs) == 2168, "Darwin64 statfs size");
static_assert(offsetof(struct statfs, f_fsid) == 48, "Darwin64 filesystem identity offset");
static_assert(offsetof(struct statfs, f_fstypename) == 72, "Darwin64 filesystem type offset");
static_assert(offsetof(struct statfs, f_mntonname) == 88, "Darwin64 mount point offset");
static_assert(offsetof(struct statfs, f_mntfromname) == 1112, "Darwin64 mount source offset");
static_assert(sizeof(struct tm) == 56, "Darwin64 calendar size");
static_assert(offsetof(struct tm, tm_gmtoff) == 40, "Darwin64 calendar offset");
static_assert(offsetof(struct tm, tm_zone) == 48, "Darwin64 calendar zone");

extern "C" unsigned probe_calendar_cpp(long long timestamp, int *output) {
 time_t value = timestamp; struct tm result; errno = 0;
 if (!gmtime_r(&value, &result)) return errno;
 const int fields[] = {result.tm_sec, result.tm_min, result.tm_hour, result.tm_mday, result.tm_mon, result.tm_year, result.tm_wday, result.tm_yday, result.tm_isdst};
 std::memcpy(output, fields, sizeof(fields)); return 0;
}

extern "C" unsigned probe_executable_cpp() {
 unsigned checks = 0; uint32_t size = 0;
 if (_NSGetExecutablePath(nullptr, &size) == -1 && size > 1) checks |= 1;
 char *buffer = static_cast<char *>(std::malloc(size + 8));
 if (!buffer) return 0;
 std::memset(buffer, 0x5a, size + 8); const uint32_t required = size;
 if (_NSGetExecutablePath(buffer, &size) == 0 && size == required && std::strlen(buffer) + 1 == required) checks |= 2;
 if (buffer[required] == 0x5a && buffer[required + 7] == 0x5a) checks |= 4;
 size = required - 1; buffer[0] = 0x5a;
 if (_NSGetExecutablePath(buffer, &size) == -1 && size == required && buffer[0] == 0x5a) checks |= 8;
 std::free(buffer); return checks;
}

extern "C" unsigned probe_filesystem_cpp(const char *path) {
 unsigned checks = 0;
 struct statfs information, other;
 if (!statfs(path, &information)) {
  checks |= 1;
  if (information.f_bsize && information.f_blocks >= information.f_bfree && information.f_bfree >= information.f_bavail) checks |= 2;
  if (information.f_fstypename[0] && information.f_mntonname[0] == '/' && information.f_mntfromname[0]) checks |= 4;
 }
 int descriptor = open(path, O_RDONLY);
 if (descriptor >= 0) {
  if (!fstatfs(descriptor, &other) && std::memcmp(&other.f_fsid, &information.f_fsid, sizeof(fsid_t)) == 0) checks |= 8;
  close(descriptor);
 }
 errno = 0; if (fstatfs(-1, &other) == -1 && errno == EBADF) checks |= 16;
 char child[4096]; std::strcpy(child, path); std::strcat(child, "/missing");
 errno = 0; if (statfs(child, &other) == -1 && errno == ENOTDIR) checks |= 32;
 return checks;
}

extern "C" long long probe_steady_clock() { return std::chrono::steady_clock::now().time_since_epoch().count(); }
extern "C" long long probe_system_clock() { return std::chrono::system_clock::now().time_since_epoch().count(); }

extern "C" unsigned probe_cwd_cpp() {
 unsigned checks = 0;
 char buffer[4096];
 if (getcwd(buffer, sizeof(buffer)) == buffer && buffer[0] == '/') checks |= 1;
 char *owned = getcwd(nullptr, 1);
 if (owned && std::strcmp(owned, buffer) == 0) checks |= 2;
 std::free(owned);
 char sentinel[8] = "canary";
 errno = 0; if (!getcwd(sentinel, 1) && errno == ERANGE) checks |= 4;
 errno = 0; if (!getcwd(sentinel, 0) && errno == EINVAL) checks |= 8;
 if (std::strcmp(sentinel, "canary") == 0) checks |= 16;
 return checks;
}

extern "C" unsigned probe_nothrow_cpp() {
 unsigned char *buffer = new (std::nothrow) unsigned char[8192];
 if (!buffer) return 0;
 buffer[0] = 42; buffer[8191] = 37;
 const unsigned result = buffer[0] + buffer[8191];
 delete[] buffer; return result;
}

extern "C" unsigned probe_timed_cpp() {
 std::unique_lock<std::mutex> lock(mutex);
 const auto status = condition.wait_until(lock, std::chrono::system_clock::now() + std::chrono::milliseconds(10));
 return status == std::cv_status::timeout && lock.owns_lock() ? 1 : 0;
}

static void *worker(void *) {
 std::unique_lock<std::mutex> lock(mutex);
 waiting = true; condition.notify_all();
 condition.wait(lock, [] { return released; });
 result = 42; condition.notify_one();
 return reinterpret_cast<void *>(0xfedcba9876543210ull);
}

extern "C" unsigned probe_cpp() {
 unsigned checks = 0;
 pthread_t thread;
 void *value = nullptr;
 if (!pthread_create(&thread, nullptr, worker, nullptr)) checks |= 1;
 std::unique_lock<std::mutex> lock(mutex);
 condition.wait(lock, [] { return waiting; });
 if (waiting) checks |= 2;
 released = true; condition.notify_all(); lock.unlock();
 if (!pthread_join(thread, &value)) checks |= 4;
 if (reinterpret_cast<std::uintptr_t>(value) == 0xfedcba9876543210ull) checks |= 8;
 if (result == 42) checks |= 16;
 return checks;
}

#ifdef NATIVE
int main(int argc, char **argv) {
 if (argc > 1 && std::strcmp(argv[1], "calendar") == 0) {
  const long long samples[] = {0, -1, 951782400, 2147483648ll, 4107542400ll, -62167219200ll, 253402300799ll, -8640000000000ll, 8640000000000ll, INT64_MIN, INT64_MAX};
  for (long long timestamp : samples) {
   int fields[9] = {}; unsigned error = probe_calendar_cpp(timestamp, fields);
   std::printf("[\"%lld\",%u", timestamp, error);
   for (int field : fields) std::printf(",%d", field);
   std::printf("]\n");
  }
  return 0;
 }
 if (argc < 1 || probe_filesystem_cpp(argv[0]) != 63) return 1;
 if (probe_executable_cpp() != 15) return 1;
 if (probe_steady_clock() < 0 || probe_system_clock() <= 0) return 1;
 if (probe_timed_cpp() != 1) return 1;
 if (probe_cwd_cpp() != 31 || probe_nothrow_cpp() != 79) return 1;
 std::printf("%u\n", probe_cpp()); return 0;
}
#endif
