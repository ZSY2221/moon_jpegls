from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from corpus import fixtures
import validate


def boundary_shapes(bits):
    near = min(255, ((1 << bits) - 1) // 2)
    for shape, samples in fixtures(bits):
        if shape in {"row", "column"}:
            yield shape, near, samples


validate.near_matrix_fixtures = boundary_shapes
validate.main()
