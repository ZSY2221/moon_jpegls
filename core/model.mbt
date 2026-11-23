///|
let run_exponents : FixedArray[Int32] = [
  0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 10,
  11, 12, 13, 14, 15,
]

///|
priv struct RegularContext {
  mut a : Int32
  mut b : Int32
  mut c : Int32
  mut n : Int32
}

///|
priv struct RunContext {
  mut a : Int32
  mut n : Int32
  mut negatives : Int32
}

///|
priv struct Scan {
  params : Parameters
  width : Int32
  regular : FixedArray[RegularContext]
  runs : FixedArray[RunContext]
  mut previous : FixedArray[Int32]
  mut current : FixedArray[Int32]
  mut previous_left : Int32
  mut x : Int32
  mut rows : Int32
  mut run_index : Int32
}

///|
fn Scan::new(width : Int32, params : Parameters) -> Scan {
  let a = max(2, (params.range + 32) / 64)
  let regular = FixedArray::makei(365, _ => { a, b: 0, c: 0, n: 1, })
  let runs = FixedArray::makei(2, _ => { a, n: 1, negatives: 0, })
  {
    params,
    width,
    regular,
    runs,
    previous: FixedArray::make(width, 0),
    current: FixedArray::make(width, 0),
    previous_left: 0,
    x: 0,
    rows: 0,
    run_index: 0,
  }
}

///|
fn Scan::workspace_bytes(self : Scan) -> Int32 {
  // Logical 32-bit sample and context counter payload, excluding object overhead.
  8 * self.width + 4 * (365 * 4 + 2 * 3)
}

///|
fn Scan::left(self : Scan) -> Int32 {
  if self.x == 0 {
    self.previous[0]
  } else {
    self.current[self.x - 1]
  }
}

///|
fn Scan::store(self : Scan, value : Int32) -> Unit {
  self.current[self.x] = value
  self.x += 1
}

///|
fn Scan::next_row(self : Scan) -> Unit {
  let reusable = self.previous
  self.previous_left = reusable[0]
  self.previous = self.current
  self.current = reusable
  self.x = 0
  self.rows += 1
}

///|
fn quantize_gradient(p : Parameters, gradient : Int32) -> Int32 {
  let magnitude = gradient.abs()
  let bucket = if magnitude >= p.t3 {
    4
  } else if magnitude >= p.t2 {
    3
  } else if magnitude >= p.t1 {
    2
  } else if magnitude > p.near {
    1
  } else {
    0
  }
  if gradient < 0 {
    -bucket
  } else {
    bucket
  }
}

///|
fn Scan::neighbors(self : Scan) -> (Int32, Int32, Int32, Int32) {
  let x = self.x
  let a = self.left()
  let b = self.previous[x]
  let c = if x == 0 { self.previous_left } else { self.previous[x - 1] }
  let d = self.previous[min(x + 1, self.width - 1)]
  (a, b, c, d)
}

///|
fn Scan::context_id(
  self : Scan,
  a : Int32,
  b : Int32,
  c : Int32,
  d : Int32,
) -> Int32 {
  let p = self.params
  81 * quantize_gradient(p, d - b) +
  9 * quantize_gradient(p, b - c) +
  quantize_gradient(p, c - a)
}

///|
fn sign_of(value : Int32) -> Int32 {
  if value < 0 {
    -1
  } else {
    1
  }
}

///|
fn Scan::prediction(
  self : Scan,
  a : Int32,
  b : Int32,
  c : Int32,
  context : Int32,
) -> Int32 {
  let low = min(a, b)
  let high = max(a, b)
  let edge = if c >= high { low } else if c <= low { high } else { a + b - c }
  let bias = self.regular[context.abs()].c * sign_of(context)
  min(self.params.maxval, max(0, edge + bias))
}

///|
fn Parameters::reduce(self : Parameters, delta : Int32) -> Int32 {
  let quantized = if delta < 0 {
    -((-delta + self.near) / self.step)
  } else {
    (delta + self.near) / self.step
  }
  let nonnegative = if quantized < 0 {
    quantized + self.range
  } else {
    quantized
  }
  if nonnegative >= (self.range + 1) / 2 {
    nonnegative - self.range
  } else {
    nonnegative
  }
}

///|
fn Parameters::reconstruct(
  self : Parameters,
  predicted : Int32,
  error : Int32,
) -> Int32 {
  let corrected = predicted + error * self.step
  let wrap = self.range * self.step
  let in_range = if corrected < -self.near {
    corrected + wrap
  } else if corrected > self.maxval + self.near {
    corrected - wrap
  } else {
    corrected
  }
  min(self.maxval, max(0, in_range))
}

///|
fn Parameters::check_error(
  self : Parameters,
  error : Int32,
) -> Unit raise CodecError {
  guard error >= -(self.range / 2) && error <= (self.range - 1) / 2 else {
    raise InvalidData("prediction residual outside RANGE")
  }
}

///|
fn golomb_order(a : Int32, n : Int32) -> Int32 {
  let mut order = 0
  let mut scale = n
  while scale < a {
    scale *= 2
    order += 1
  }
  order
}

///|
fn RegularContext::invert(
  self : RegularContext,
  k : Int32,
  near : Int32,
) -> Bool {
  near == 0 && k == 0 && self.b * 2 <= -self.n
}

///|
fn RegularContext::update(
  self : RegularContext,
  p : Parameters,
  error : Int32,
) -> Unit {
  self.a += error.abs()
  self.b += error * p.step
  if self.n == p.reset {
    self.a = self.a >> 1
    self.b = self.b >> 1
    self.n = self.n >> 1
  }
  self.n += 1
  if self.b <= -self.n {
    self.b = max(-self.n + 1, self.b + self.n)
    self.c = max(-128, self.c - 1)
  } else if self.b > 0 {
    self.b = min(0, self.b - self.n)
    self.c = min(127, self.c + 1)
  }
}

///|
fn RunContext::order(self : RunContext, kind : Int32) -> Int32 {
  golomb_order(self.a + (self.n >> 1) * kind, self.n)
}

///|
fn RunContext::negative_odd(self : RunContext, k : Int32) -> Bool {
  k != 0 || 2 * self.negatives >= self.n
}

///|
fn RunContext::update(
  self : RunContext,
  p : Parameters,
  kind : Int32,
  error : Int32,
  mapped : Int32,
) -> Unit {
  if error < 0 {
    self.negatives += 1
  }
  self.a += (mapped + 1 - kind) >> 1
  if self.n == p.reset {
    self.a = self.a >> 1
    self.n = self.n >> 1
    self.negatives = self.negatives >> 1
  }
  self.n += 1
}

///|
fn Scan::run_prediction(self : Scan, a : Int32) -> (Int32, Int32, Int32) {
  let b = self.previous[self.x]
  if (a - b).abs() <= self.params.near {
    (1, a, 1)
  } else {
    (0, b, sign_of(b - a))
  }
}

///|
fn map_regular(error : Int32) -> Int32 {
  if error < 0 {
    -2 * error - 1
  } else {
    2 * error
  }
}

///|
fn unmap_regular(mapped : Int32) -> Int32 {
  if (mapped & 1) == 0 {
    mapped >> 1
  } else {
    -((mapped + 1) >> 1)
  }
}
