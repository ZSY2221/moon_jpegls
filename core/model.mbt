///|
let run_exponents : FixedArray[Int32] = [
  0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 10,
  11, 12, 13, 14, 15,
]

///|
priv struct Scan {
  params : Parameters
  width : Int32
  ctx_a : FixedArray[Int32]
  ctx_b : FixedArray[Int32]
  ctx_c : FixedArray[Int32]
  ctx_n : FixedArray[Int32]
  run_a : FixedArray[Int32]
  run_n : FixedArray[Int32]
  run_neg : FixedArray[Int32]
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
  {
    params,
    width,
    ctx_a: FixedArray::make(365, a),
    ctx_b: FixedArray::make(365, 0),
    ctx_c: FixedArray::make(365, 0),
    ctx_n: FixedArray::make(365, 1),
    run_a: FixedArray::make(2, a),
    run_n: FixedArray::make(2, 1),
    run_neg: FixedArray::make(2, 0),
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
  // Owned 32-bit array payload, including the per-scan gradient lookup table.
  // Shared module tables, scalar fields, references and object overhead are excluded.
  4 *
  (self.previous.length() + self.current.length() +
   self.ctx_a.length() + self.ctx_b.length() + self.ctx_c.length() +
   self.ctx_n.length() + self.run_a.length() + self.run_n.length() +
   self.run_neg.length() + self.params.q_lut.length())
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
  let idx = gradient + p.t3
  if idx >= 0 && idx < p.q_lut.length() {
    p.q_lut[idx]
  } else if gradient < 0 {
    -4
  } else {
    4
  }
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
fn abs_i32(value : Int32) -> Int32 {
  if value < 0 {
    -value
  } else {
    value
  }
}

///|
fn med_predict(a : Int32, b : Int32, c : Int32) -> Int32 {
  let (low, high) = if a < b { (a, b) } else { (b, a) }
  if c >= high {
    low
  } else if c <= low {
    high
  } else {
    a + b - c
  }
}

///|
fn clamp_sample(value : Int32, maxval : Int32) -> Int32 {
  if value < 0 {
    0
  } else if value > maxval {
    maxval
  } else {
    value
  }
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
  (quantize_gradient(p, d - b) * 9 + quantize_gradient(p, b - c)) * 9 +
  quantize_gradient(p, c - a)
}

///|
fn Scan::prediction_at(
  self : Scan,
  a : Int32,
  b : Int32,
  c : Int32,
  index : Int32,
  sign : Int32,
) -> Int32 {
  let edge = med_predict(a, b, c)
  let bias = self.ctx_c[index] * sign
  clamp_sample(edge + bias, self.params.maxval)
}

///|
fn Parameters::reduce(self : Parameters, delta : Int32) -> Int32 {
  let quantized = if self.near == 0 {
    delta
  } else if delta < 0 {
    let mag = -delta + self.near
    let q = match self.step {
      3 => mag / 3
      5 => mag / 5
      7 => mag / 7
      _ => mag / self.step
    }
    -q
  } else {
    let mag = delta + self.near
    match self.step {
      3 => mag / 3
      5 => mag / 5
      7 => mag / 7
      _ => mag / self.step
    }
  }
  if quantized >= self.half_range {
    quantized - self.range
  } else if quantized < self.min_err {
    quantized + self.range
  } else {
    quantized
  }
}

///|
fn Parameters::reconstruct(
  self : Parameters,
  predicted : Int32,
  error : Int32,
) -> Int32 {
  if self.near == 0 {
    let corrected = predicted + error
    if corrected < 0 {
      corrected + self.range
    } else if corrected > self.maxval {
      corrected - self.range
    } else {
      corrected
    }
  } else {
    let corrected = predicted + error * self.step
    let in_range = if corrected < self.neg_near {
      corrected + self.wrap
    } else if corrected > self.maxval_plus_near {
      corrected - self.wrap
    } else {
      corrected
    }
    clamp_sample(in_range, self.maxval)
  }
}

///|
fn Parameters::is_valid_error(self : Parameters, error : Int32) -> Bool {
  error >= self.min_err && error <= self.max_err
}

///|
fn golomb_order(a : Int32, n : Int32) -> Int32 {
  if n >= a {
    0
  } else {
    let k = n.clz() - a.clz()
    if (n << k) < a {
      k + 1
    } else {
      k
    }
  }
}

///|
fn Scan::regular_invert(
  self : Scan,
  index : Int32,
  k : Int32,
) -> Int32 {
  if self.params.near == 0 && k == 0 && (self.ctx_b[index] << 1) <= -self.ctx_n[index] {
    1
  } else {
    0
  }
}

///|
fn Scan::update_regular(
  self : Scan,
  index : Int32,
  error : Int32,
) -> Unit {
  let p = self.params
  let mut a = self.ctx_a[index] + abs_i32(error)
  let mut b = self.ctx_b[index] + error * p.step
  let mut n = self.ctx_n[index]
  if n == p.reset {
    a = a >> 1
    b = b >> 1
    n = n >> 1
  }
  n += 1
  let mut c = self.ctx_c[index]
  if b <= -n {
    b += n
    if b <= -n {
      b = -n + 1
    }
    if c > -128 {
      c -= 1
    }
  } else if b > 0 {
    b -= n
    if b > 0 {
      b = 0
    }
    if c < 127 {
      c += 1
    }
  }
  self.ctx_a[index] = a
  self.ctx_b[index] = b
  self.ctx_c[index] = c
  self.ctx_n[index] = n
}

///|
fn Scan::run_order(self : Scan, kind : Int32) -> Int32 {
  let n = self.run_n[kind]
  golomb_order(self.run_a[kind] + ((n >> 1) & (if kind != 0 { -1 } else { 0 })), n)
}

///|
fn Scan::run_negative_odd(self : Scan, kind : Int32, k : Int32) -> Bool {
  k != 0 || (self.run_neg[kind] << 1) >= self.run_n[kind]
}

///|
fn Scan::update_run(
  self : Scan,
  kind : Int32,
  error : Int32,
  mapped : Int32,
) -> Unit {
  let p = self.params
  let mut neg = self.run_neg[kind] + (if error < 0 { 1 } else { 0 })
  let mut a = self.run_a[kind] + ((mapped + 1 - kind) >> 1)
  let mut n = self.run_n[kind]
  if n == p.reset {
    a = a >> 1
    n = n >> 1
    neg = neg >> 1
  }
  self.run_a[kind] = a
  self.run_n[kind] = n + 1
  self.run_neg[kind] = neg
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
