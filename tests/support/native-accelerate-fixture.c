#include <Accelerate/Accelerate.h>
#include <stdint.h>
#include <string.h>

static float output[4096];
static int used;
static void emit(const float *values, int count) { memcpy(output + used, values, count * sizeof(float)); used += count; }
static void emitDouble(const double *values, int count) { for (int index = 0; index < count; index++) { float value = (float)values[index]; emit(&value, 1); } }

float *probe_accelerate(int *size) {
 float a[8] = { 1, -2, 3.5f, -4, 5, 0.25f, -6, 7 }, b[8] = { 2, 2, -1, 0.5f, 8, -3, 1, 4 }, c[8] = { 0.5f, 1, 1.5f, 2, 2.5f, 3, 3.5f, 4 }, result[8];
 double da[4] = { 1.5, -2.5, 3.25, 4 }, db[4] = { 2, -1, 0.5, 8 }, dresult[4];
 float scalar = 1.5f, low = -1, high = 2;
 used = 0;
 vDSP_vadd(a, 1, b, 1, result, 1, 8); emit(result, 8);
 vDSP_vsub(b, 1, a, 1, result, 1, 8); emit(result, 8);
 vDSP_vmul(a, 1, b, 1, result, 1, 8); emit(result, 8);
 vDSP_vdiv(b, 1, a, 1, result, 1, 8); emit(result, 8);
 vDSP_vma(a, 1, b, 1, c, 1, result, 1, 8); emit(result, 8);
 vDSP_vsma(a, 1, &scalar, c, 1, result, 1, 8); emit(result, 8);
 vDSP_vsadd(a, 1, &scalar, result, 1, 8); emit(result, 8);
 vDSP_vsmul(a, 1, &scalar, result, 1, 8); emit(result, 8);
 vDSP_vabs(a, 1, result, 1, 8); emit(result, 8);
 vDSP_vneg(a, 1, result, 1, 8); emit(result, 8);
 vDSP_vmax(a, 1, b, 1, result, 1, 8); emit(result, 8);
 vDSP_vmin(a, 1, b, 1, result, 1, 8); emit(result, 8);
 vDSP_vclip(a, 1, &low, &high, result, 1, 8); emit(result, 8);
 vDSP_vadd(a, 2, b, 2, result, 1, 4); emit(result, 4);
 memcpy(result, a, sizeof a); vDSP_vsmul(a, 2, &scalar, result, 2, 4); emit(result, 8);
 vDSP_vclr(result, 1, 8); emit(result, 8);
 vDSP_vfill(&scalar, result, 1, 8); emit(result, 8);
 vDSP_vaddD(da, 1, db, 1, dresult, 1, 4); emitDouble(dresult, 4);
 vDSP_vmulD(da, 1, db, 1, dresult, 1, 4); emitDouble(dresult, 4);
 float value; vDSP_Length where;
 vDSP_dotpr(a, 1, b, 1, &value, 8); emit(&value, 1);
 vDSP_maxvi(a, 1, &value, &where, 8); emit(&value, 1); value = (float)where; emit(&value, 1);
 vDSP_minvi(a, 2, &value, &where, 4); emit(&value, 1); value = (float)where; emit(&value, 1);
 vDSP_meanv(a, 1, &value, 8); emit(&value, 1);
 vDSP_rmsqv(a, 1, &value, 8); emit(&value, 1);
 float re[8] = { 1, 0, -1, 2, 0.5f, 3, -3, 4 }, im[8] = { 0, 1, 2, -2, 0.25f, 4, 1, -1 };
 DSPSplitComplex split = { re, im };
 vDSP_zvabs(&split, 1, result, 1, 8); emit(result, 8);
 vDSP_zvphas(&split, 1, result, 1, 8); emit(result, 8);
 DSPComplex pairs[4] = { { 1, 2 }, { 3, 4 }, { 5, 6 }, { 7, 8 } };
 float realp[4], imagp[4]; DSPSplitComplex packed = { realp, imagp };
 vDSP_ctoz(pairs, 2, &packed, 1, 4); emit(realp, 4); emit(imagp, 4);
 DSPComplex back[4]; vDSP_ztoc(&packed, 1, back, 2, 4); emit((float *)back, 8);
 FFTSetup setup = vDSP_create_fftsetup(4, FFT_RADIX2);
 float signal[16], part1[8], part2[8]; DSPSplitComplex frame = { part1, part2 };
 for (int index = 0; index < 16; index++) signal[index] = (float)(index * index % 7) - 3 + index * 0.125f;
 vDSP_ctoz((DSPComplex *)signal, 2, &frame, 1, 8);
 vDSP_fft_zrip(setup, &frame, 1, 4, FFT_FORWARD); emit(part1, 8); emit(part2, 8);
 vDSP_fft_zrip(setup, &frame, 1, 4, FFT_INVERSE); emit(part1, 8); emit(part2, 8);
 float inr[8], ini[8], outr[8], outi[8]; DSPSplitComplex in = { inr, ini }, out = { outr, outi };
 for (int index = 0; index < 8; index++) { inr[index] = index * 0.5f - 1; ini[index] = 3 - index * 0.25f; }
 vDSP_fft_zop(setup, &in, 1, &out, 1, 3, FFT_FORWARD); emit(outr, 8); emit(outi, 8);
 vDSP_fft_zop(setup, &in, 1, &out, 1, 3, FFT_INVERSE); emit(outr, 8); emit(outi, 8);
 vDSP_destroy_fftsetup(setup);
 float x[5] = { 0.1f, 1, 2.5f, -3, 10 }, sine[5], cosine[5], y[5]; int n = 5;
 vvsincosf(sine, cosine, x, &n); emit(sine, 5); emit(cosine, 5);
 vvexpf(y, x, &n); emit(y, 5);
 float positive[5] = { 0.1f, 1, 2.5f, 3, 10 };
 vvlogf(y, positive, &n); emit(y, 5);
 vvsqrtf(y, positive, &n); emit(y, 5);
 *size = used; return output;
}

#ifdef NATIVE
#include <stdio.h>
int main(void) { int size; float *data = probe_accelerate(&size); for (int index = 0; index < size; index++) printf("%.9g\n", data[index]); return 0; }
#endif
