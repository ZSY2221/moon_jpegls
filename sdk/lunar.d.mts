export interface LunarFixture {
  readonly id: 'nasa-svs-cgi-moon-kit-lola-ldem-4-uint';
  readonly title: string;
  readonly sourcePage: string;
  readonly sourceUrl: string;
  readonly credit: string;
  readonly tiffBytes: number;
  readonly tiffSha256: string;
  readonly pgmBytes: number;
  readonly pgmSha256: string;
  readonly width: number;
  readonly height: number;
  readonly bits: 16;
  readonly sampleOffset: number;
  readonly metersPerSample: number;
  readonly referenceRadiusMeters: number;
  readonly elevationUnit: 'm';
}

export const lunarFixture: LunarFixture;

export function lunarMetadataFor(input: {
  sha256: string | null;
  bytes: number;
  format: string;
}): LunarFixture | null;

/** Elevation relative to the fixture's reference sphere. */
export function lunarElevationMeters(sample: number): number;

/** Absolute reconstruction error in meters for this fixture. */
export function lunarErrorMeters(absoluteSampleError: number): number;
