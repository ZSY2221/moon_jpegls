import { deployedBuild } from './run-report.mjs';

const sourceRepository = 'https://github.com/ZSY2221/moon_jpegls';

export async function mountBuildIdentity() {
  const build = await deployedBuild();
  const revision = build?.source?.revision;
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) return;
  const label = document.getElementById('build-revision');
  label.textContent = revision.slice(0, 12);
  label.title = revision;
  document.getElementById('build-dirty').hidden = !build.source.dirty;
  document.getElementById('build-source').href = `${sourceRepository}/commit/${revision}`;
  document.getElementById('build-scope').href = `${sourceRepository}/blob/${revision}/docs/SCOPE.md`;
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function showFeatures(features, destination) {
  const rows = features.map((feature) => {
    const row = element('tr');
    row.dataset.feature = feature.feature_id;
    const name = element('th', feature.display_name);
    name.scope = 'row';
    name.append(element('small', feature.target_milestone));
    const states = ['encode_status', 'decode_status', 'format_status'].map((field) => feature[field]);
    const status = element('td', `archived: ${states.join(' / ')}`);
    status.dataset.encode = states[0];
    status.dataset.decode = states[1];
    status.dataset.format = states[2];
    const evidence = element('td');
    if (feature.test_ids.length) evidence.append(element('strong', feature.test_ids.join(', ')));
    if (feature.reference_support) evidence.append(element('small', feature.reference_support));
    if (feature.notes) evidence.append(element('small', feature.notes));
    if (feature.evidence_path) {
      const evidenceRef = feature.evidence_ref ?? feature.source_revision;
      if (evidenceRef) {
        const link = element('a', feature.evidence_path);
        link.href = `${sourceRepository}/blob/${encodeURIComponent(evidenceRef)}/${encodeURI(feature.evidence_path)}`;
        if (feature.source_revision) link.title = feature.source_revision;
        evidence.append(link);
      } else {
        evidence.append(element('small', feature.evidence_path));
      }
    }
    row.append(name, element('td', feature.standard_clause), status, evidence);
    return row;
  });
  destination.replaceChildren(...rows);
}

export async function mountCompatibility(unavailable) {
  const destination = document.getElementById('compatibility-features');
  if (!destination || typeof document.createElement !== 'function') return;
  const standard = document.getElementById('compatibility-standard');
  try {
    const response = await fetch(new URL('./conformance-manifest.json', import.meta.url));
    if (!response.ok) throw new Error('Could not load the conformance manifest');
    const manifest = await response.json();
    showFeatures(manifest.features, destination);
    const byRevision = new Map();
    for (const item of manifest.cases) {
      const passed = ['js', 'wasm-gc', 'native'].every((backend) => {
        const result = item.results?.[backend];
        return result?.encode?.status === 'passed' && result?.decode?.status === 'passed';
      });
      if (passed && item.source_revision) {
        byRevision.set(item.source_revision, (byRevision.get(item.source_revision) ?? 0) + 1);
      }
    }
    const passed = Math.max(0, ...byRevision.values());
    standard.textContent = `${manifest.standard} · ${passed}/${manifest.cases.length}`;
    const cases = manifest.cases.map((fixture) => {
      const item = element('li', `${fixture.test_id} ${fixture.file} (${fixture.expected})`);
      item.title = fixture.sha256;
      if (fixture.results) {
        const observed = Object.entries(fixture.results).map(([backend, result]) =>
          `${backend}: ${result.encode?.status ?? 'not_run'} / ${result.decode?.status ?? 'not_run'}`).join('; ');
        if (observed) item.append(element('small', ` ${observed}`));
      }
      return item;
    });
    document.getElementById('compatibility-cases').replaceChildren(...cases);
  } catch {
    standard.textContent = unavailable();
  }
}
