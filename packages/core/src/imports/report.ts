/** Content-free import and migration diagnostics. No untrusted text is interpolated. */
export interface ConversionReport {
  kept: string[];
  changed: string[];
  skipped: string[];
}
export const emptyConversionReport = (): ConversionReport => ({
  kept: [],
  changed: [],
  skipped: [],
});
