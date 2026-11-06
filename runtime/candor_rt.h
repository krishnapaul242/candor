/* Candor runtime — shared by the JS-hosted and self-hosted compilers. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <math.h>
#include <time.h>

typedef struct { int64_t len; const char* p; } cn_str;
typedef struct { int64_t len, cap; void* data; } cn_arr;
#define CN_MAXI 9007199254740991LL
#define CN_S(lit, n) ((cn_str){ (n), (lit) })

__attribute__((noreturn, cold)) static void cn_trap(const char* fn, int line, const char* fmt, ...);
#include <stdarg.h>
static void cn_trap(const char* fn, int line, const char* fmt, ...) {
  fflush(stdout);
  fprintf(stderr, "trap in %s at line %d: ", fn, line);
  va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap);
  fputc('\n', stderr);
  exit(1);
}

/* bump allocator: Candor v0 never frees (see README) */
static char* cn_heap; static size_t cn_heap_left;
static inline void* cn_alloc(size_t n) {
  n = (n + 15) & ~(size_t)15;
  if (n > cn_heap_left) {
    size_t chunk = n > (1u << 20) ? n : (1u << 20);
    cn_heap = malloc(chunk); if (!cn_heap) { fputs("out of memory\n", stderr); exit(2); }
    cn_heap_left = chunk;
  }
  void* p = cn_heap; cn_heap += n; cn_heap_left -= n; return p;
}

static inline int64_t cn_ovf(int64_t r, const char* fn, int line) {
  if (__builtin_expect(r > CN_MAXI || r < -CN_MAXI, 0)) cn_trap(fn, line, "integer overflow");
  return r;
}
static inline int64_t cn_mul(int64_t a, int64_t b, const char* fn, int line) {
  int64_t r;
  if (__builtin_mul_overflow(a, b, &r)) cn_trap(fn, line, "integer overflow");
  return cn_ovf(r, fn, line);
}
static inline int64_t cn_div(int64_t a, int64_t b, const char* fn, int line) {
  if (__builtin_expect(b == 0, 0)) cn_trap(fn, line, "division by zero");
  return a / b;
}
static inline int64_t cn_mod(int64_t a, int64_t b, const char* fn, int line) {
  if (__builtin_expect(b == 0, 0)) cn_trap(fn, line, "division by zero");
  return a % b;
}
static inline int64_t cn_at(cn_arr* a, int64_t i, const char* fn, int line) {
  if (__builtin_expect(i < 0 || i >= a->len, 0)) cn_trap(fn, line, "index %lld out of bounds for length %lld", (long long)i, (long long)a->len);
  return i;
}
static cn_arr* cn_arr_new(int64_t n, size_t es) {
  cn_arr* a = cn_alloc(sizeof(cn_arr));
  a->len = n; a->cap = n < 4 ? 4 : n;
  a->data = malloc((size_t)a->cap * es);
  return a;
}
static inline void* cn_arr_grow(cn_arr* a, size_t es) {
  if (a->len == a->cap) { a->cap *= 2; a->data = realloc(a->data, (size_t)a->cap * es); }
  return (char*)a->data + (size_t)(a->len++) * es;
}
static inline bool cn_str_eq(cn_str a, cn_str b) { return a.len == b.len && memcmp(a.p, b.p, (size_t)a.len) == 0; }
static cn_str cn_cat(cn_str a, cn_str b) {
  char* p = cn_alloc((size_t)(a.len + b.len) + 1);
  memcpy(p, a.p, (size_t)a.len); memcpy(p + a.len, b.p, (size_t)b.len);
  return (cn_str){ a.len + b.len, p };
}
static cn_str cn_dup(const char* s) {
  size_t n = strlen(s); char* p = cn_alloc(n + 1); memcpy(p, s, n + 1);
  return (cn_str){ (int64_t)n, p };
}
static inline void cn_print(cn_str s) { fwrite(s.p, 1, (size_t)s.len, stdout); fputc('\n', stdout); }
static cn_str cn_show_i(int64_t x) { char b[32]; snprintf(b, sizeof b, "%lld", (long long)x); return cn_dup(b); }
static cn_str cn_show_b(bool x) { return x ? CN_S("true", 4) : CN_S("false", 5); }
static void cn_fmt_float(char* out, const char* d, int nd, int exp) {
  char* o = out;
  if (exp >= -7 && exp < 21) {
    if (exp >= 0) {
      for (int i = 0; i <= exp; i++) *o++ = i < nd ? d[i] : '0';
      *o++ = '.';
      if (nd > exp + 1) for (int i = exp + 1; i < nd; i++) *o++ = d[i];
      else *o++ = '0';
    } else {
      *o++ = '0'; *o++ = '.';
      for (int i = 0; i < -exp - 1; i++) *o++ = '0';
      for (int i = 0; i < nd; i++) *o++ = d[i];
    }
    *o = 0;
  } else {
    *o++ = d[0];
    if (nd > 1) { *o++ = '.'; for (int i = 1; i < nd; i++) *o++ = d[i]; }
    sprintf(o, "e%c%d", exp < 0 ? '-' : '+', exp < 0 ? -exp : exp);
  }
}
static cn_str cn_show_f(double x) {
  if (isnan(x)) return CN_S("nan", 3);
  if (isinf(x)) return x > 0 ? CN_S("inf", 3) : CN_S("-inf", 4);
  if (x == 0) return signbit(x) ? CN_S("-0.0", 4) : CN_S("0.0", 3);
  bool neg = x < 0; double ax = neg ? -x : x;
  char e[40];
  for (int p = 0; p < 17; p++) { snprintf(e, sizeof e, "%.*e", p, ax); if (strtod(e, NULL) == ax) break; }
  char d[24]; int nd = 0; const char* s = e;
  while (*s && *s != 'e') { if (*s != '.') d[nd++] = *s; s++; }
  int exp = atoi(s + 1);
  while (nd > 1 && d[nd - 1] == '0') nd--;
  char buf[64]; buf[0] = '-';
  cn_fmt_float(buf + (neg ? 1 : 0), d, nd, exp);
  return cn_dup(buf);
}
static int64_t cn_to_int(double x, const char* fn, int line) {
  if (!(x > -9007199254740992.0 && x < 9007199254740992.0)) {
    cn_str s = cn_show_f(x);
    cn_trap(fn, line, "to_int: %.*s is outside Int range", (int)s.len, s.p);
  }
  return (int64_t)x;
}
static int cn_argc; static char** cn_argv;
static cn_arr* cn_args(void) {
  int n = cn_argc > 1 ? cn_argc - 1 : 0;
  cn_arr* a = cn_arr_new(n, sizeof(cn_str));
  for (int i = 0; i < n; i++) ((cn_str*)a->data)[i] = cn_dup(cn_argv[i + 1]);
  return a;
}
static inline int64_t cn_byte_at(cn_str s, int64_t i, const char* fn, int line) {
  if (__builtin_expect(i < 0 || i >= s.len, 0)) cn_trap(fn, line, "byte_at: index %lld out of bounds for length %lld", (long long)i, (long long)s.len);
  return (unsigned char)s.p[i];
}
static inline cn_str cn_slice(cn_str s, int64_t a, int64_t b, const char* fn, int line) {
  if (a < 0 || a > b || b > s.len) cn_trap(fn, line, "slice %lld..%lld out of bounds for length %lld", (long long)a, (long long)b, (long long)s.len);
  return (cn_str){ b - a, s.p + a };
}
static cn_str cn_from_byte(int64_t b, const char* fn, int line) {
  if (b < 0 || b > 255) cn_trap(fn, line, "from_byte: %lld is not a byte", (long long)b);
  char* p = cn_alloc(2); p[0] = (char)b; p[1] = 0;
  return (cn_str){ 1, p };
}
static cn_str cn_join(cn_arr* parts, cn_str sep) {
  cn_str* ps = parts->data; int64_t n = 0;
  for (int64_t i = 0; i < parts->len; i++) n += ps[i].len + (i ? sep.len : 0);
  char* p = cn_alloc((size_t)n + 1); char* o = p;
  for (int64_t i = 0; i < parts->len; i++) {
    if (i) { memcpy(o, sep.p, (size_t)sep.len); o += sep.len; }
    memcpy(o, ps[i].p, (size_t)ps[i].len); o += ps[i].len;
  }
  return (cn_str){ n, p };
}
static double cn_parse_float(cn_str s, const char* fn, int line) {
  int64_t i = 0, n = s.len; const char* p = s.p; bool ok = true, digits = false;
  if (i < n && (p[i] == '+' || p[i] == '-')) i++;
  while (i < n && p[i] >= '0' && p[i] <= '9') { i++; digits = true; }
  if (i < n && p[i] == '.') { i++; while (i < n && p[i] >= '0' && p[i] <= '9') { i++; digits = true; } }
  if (!digits) ok = false;
  if (ok && i < n && (p[i] == 'e' || p[i] == 'E')) {
    i++; if (i < n && (p[i] == '+' || p[i] == '-')) i++;
    bool ed = false; while (i < n && p[i] >= '0' && p[i] <= '9') { i++; ed = true; }
    if (!ed) ok = false;
  }
  if (!ok || i != n) cn_trap(fn, line, "parse_float: invalid number \"%.*s\"", (int)s.len, s.p);
  char* z = cn_alloc((size_t)n + 1); memcpy(z, p, (size_t)n); z[n] = 0;
  return strtod(z, NULL);
}
static char* cn_cstr(cn_str s) { char* z = cn_alloc((size_t)s.len + 1); memcpy(z, s.p, (size_t)s.len); z[s.len] = 0; return z; }
static cn_str cn_read_file(cn_str path, const char* fn, int line) {
  FILE* f = fopen(cn_cstr(path), "rb");
  if (!f) cn_trap(fn, line, "cannot read file %.*s", (int)path.len, path.p);
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  char* p = malloc((size_t)n + 1);
  if (fread(p, 1, (size_t)n, f) != (size_t)n) cn_trap(fn, line, "cannot read file %.*s", (int)path.len, path.p);
  fclose(f); p[n] = 0;
  return (cn_str){ n, p };
}
static void cn_write_file(cn_str path, cn_str c, const char* fn, int line) {
  FILE* f = fopen(cn_cstr(path), "wb");
  if (!f || fwrite(c.p, 1, (size_t)c.len, f) != (size_t)c.len) cn_trap(fn, line, "cannot write file %.*s", (int)path.len, path.p);
  fclose(f);
}
static void cn_eprint(cn_str s) { fflush(stdout); fwrite(s.p, 1, (size_t)s.len, stderr); fputc('\n', stderr); }
static void cn_exit(int64_t c) { fflush(stdout); exit((int)c); }
static int64_t cn_clock_ms(void) {
  struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
