// Simple, dependency-free RTL/LTR direction detection based on the first
// strong-direction character in the text. Arabic, Hebrew, and other RTL
// scripts get dir="rtl"; everything else (including empty/neutral text)
// defaults to "ltr".
const RTL_RANGE = /[\u0591-\u07FF\u200F\uFB1D-\uFDFD\uFE70-\uFEFC]/

export function detectDirection(text) {
  if (!text) return 'ltr'
  return RTL_RANGE.test(text) ? 'rtl' : 'ltr'
}
