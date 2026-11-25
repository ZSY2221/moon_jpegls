export const lunarFixture = Object.freeze({
  id: 'nasa-svs-cgi-moon-kit-lola-ldem-4-uint',
  title: 'NASA CGI Moon Kit · LOLA lunar elevation',
  sourcePage: 'https://svs.gsfc.nasa.gov/4720/#displacement',
  sourceUrl: 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_4_uint.tif',
  credit: 'NASA Scientific Visualization Studio, Lunar Reconnaissance Orbiter LOLA team, and Ernie Wright',
  tiffBytes: 2_076_866,
  tiffSha256: 'e6668bec27fc9b8fbb02d198c7ddfb08eedeeb790167b494f95e6b34201da05e',
  pgmBytes: 2_073_618,
  pgmSha256: '1adb4e047099b942c229a8d21d33b6227dd2b6af22984d8d9de6b128b0e858a6',
  width: 1440,
  height: 720,
  bits: 16,
  sampleOffset: 20_000,
  metersPerSample: 0.5,
  referenceRadiusMeters: 1_737_400,
  elevationUnit: 'm',
});

export function lunarMetadataFor({ sha256, bytes, format }) {
  if (format !== 'pgm' || bytes !== lunarFixture.pgmBytes ||
      typeof sha256 !== 'string' || sha256.toLowerCase() !== lunarFixture.pgmSha256) return null;
  return lunarFixture;
}

export function lunarElevationMeters(sample) {
  return (sample - lunarFixture.sampleOffset) * lunarFixture.metersPerSample;
}

export function lunarErrorMeters(absoluteSampleError) {
  return absoluteSampleError * lunarFixture.metersPerSample;
}
