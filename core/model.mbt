///|
let run_exponents : FixedArray[Int32] = [
  0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 10,
  11, 12, 13, 14, 15,
]

///|
priv struct Scan {
  params : Parameters
  ctx_a : FixedArray[UInt32]
  ctx_b : FixedArray[Int32]
  ctx_c : FixedArray[Int32]
  ctx_n : FixedArray[Int32]
  run_a : FixedArray[UInt32]
  run_n : FixedArray[Int32]
  run_neg : FixedArray[Int32]
  mut previous : FixedArray[Int32]
  mut current : FixedArray[Int32]
  mut previous_left : Int32
  mut x : Int32
  mut rows : Int32
  mut run_index : Int32
  comp_indices : Array[Int32]
  comp_ids : Array[Int32]
  comp_widths : Array[Int32]
  comp_heights : Array[Int32]
  comp_v_samplings : Array[Int32]
  comp_prev : Array[FixedArray[Int32]]
  comp_curr : Array[FixedArray[Int32]]
  comp_prev_left : FixedArray[Int32]
  comp_rows : FixedArray[Int32]
  comp_run_index : FixedArray[Int32]
  ilv : Int32
  mcu_rows : Int32
  mut active_comp : Int32
  mut mcu_v_step : Int32
  mut mcu_row : Int32
  mut last_row_comp : Int32
  mut last_row_idx : Int32
  mut active_width : Int32
  mut total_rows : Int32
}

///|
fn Scan::new(width : Int32, params : Parameters) -> Scan {
  let a = max(2, (params.range + 32) / 64)
  {
    params,
    ctx_a: FixedArray::make(365, a.reinterpret_as_uint()),
    ctx_b: FixedArray::make(365, 0),
    ctx_c: FixedArray::make(365, 0),
    ctx_n: FixedArray::make(365, 1),
    run_a: FixedArray::make(2, a.reinterpret_as_uint()),
    run_n: FixedArray::make(2, 1),
    run_neg: FixedArray::make(2, 0),
    previous: FixedArray::make(width, 0),
    current: FixedArray::make(width, 0),
    previous_left: 0,
    x: 0,
    rows: 0,
    run_index: 0,
    comp_indices: [0],
    comp_ids: [1],
    comp_widths: [width],
    comp_heights: [0],
    comp_v_samplings: [1],
    comp_prev: [],
    comp_curr: [],
    comp_prev_left: [],
    comp_rows: [],
    comp_run_index: [],
    ilv: 0,
    mcu_rows: 0,
    active_comp: 0,
    mcu_v_step: 0,
    mcu_row: 0,
    last_row_comp: 0,
    last_row_idx: -1,
    active_width: width,
    total_rows: 0,
  }
}

///|
fn Scan::new_interleaved(
  info : FrameInfo,
  scan_info : ScanInfo,
  params : Parameters,
) -> Scan {
  let ilv = scan_info.interleave
  let comp_indices = scan_info.component_indices.copy()
  let comp_ids = scan_info.component_ids.copy()
  let ns = comp_indices.length()
  let comp_widths : Array[Int32] = []
  let comp_heights : Array[Int32] = []
  let comp_v_samplings : Array[Int32] = []
  let max_v = info.max_v_sampling()
  for ci in comp_indices {
    comp_widths.push(info.component_width(ci))
    comp_heights.push(info.component_height(ci))
    comp_v_samplings.push(info.components[ci].v_sampling)
  }
  let mcu_rows = if ilv == 2 {
    comp_heights[0]
  } else {
    ceil_div(info.height, max_v)
  }
  if ilv == 0 && ns == 1 {
    let base = Scan::new(comp_widths[0], params)
    return {
      ..base,
      comp_indices,
      comp_ids,
      comp_widths,
      comp_heights,
      comp_v_samplings,
      mcu_rows: comp_heights[0],
      active_width: comp_widths[0],
    }
  }
  let a = max(2, (params.range + 32) / 64)
  let comp_prev : Array[FixedArray[Int32]] = []
  let comp_curr : Array[FixedArray[Int32]] = []
  for w in comp_widths {
    comp_prev.push(FixedArray::make(w, 0))
    comp_curr.push(FixedArray::make(w, 0))
  }
  {
    params,
    ctx_a: FixedArray::make(365, a.reinterpret_as_uint()),
    ctx_b: FixedArray::make(365, 0),
    ctx_c: FixedArray::make(365, 0),
    ctx_n: FixedArray::make(365, 1),
    run_a: FixedArray::make(2, a.reinterpret_as_uint()),
    run_n: FixedArray::make(2, 1),
    run_neg: FixedArray::make(2, 0),
    previous: comp_prev[0],
    current: comp_curr[0],
    previous_left: 0,
    x: 0,
    rows: 0,
    run_index: 0,
    comp_indices,
    comp_ids,
    comp_widths,
    comp_heights,
    comp_v_samplings,
    comp_prev,
    comp_curr,
    comp_prev_left: FixedArray::make(ns, 0),
    comp_rows: FixedArray::make(ns, 0),
    comp_run_index: FixedArray::make(if ilv == 1 { ns } else { 0 }, 0),
    ilv,
    mcu_rows,
    active_comp: 0,
    mcu_v_step: 0,
    mcu_row: 0,
    last_row_comp: 0,
    last_row_idx: -1,
    active_width: comp_widths[0],
    total_rows: 0,
  }
}

///|
fn Scan::workspace_bytes(self : Scan) -> Int32 {
  // Owned 32-bit array payload, including the per-scan gradient lookup table.
  // Shared module tables, scalar fields, references and object overhead are excluded.
  let line_words = if self.comp_prev.length() == 0 {
    self.previous.length() + self.current.length()
  } else {
    let mut sum = self.comp_prev_left.length() +
      self.comp_rows.length() +
      self.comp_run_index.length()
    for c in 0..<self.comp_prev.length() {
      sum += self.comp_prev[c].length() + self.comp_curr[c].length()
    }
    sum
  }
  4 *
  (line_words +
   self.ctx_a.length() + self.ctx_b.length() + self.ctx_c.length() +
   self.ctx_n.length() + self.run_a.length() + self.run_n.length() +
   self.run_neg.length() + self.params.q_lut.length())
}

///|
fn Scan::is_finished(self : Scan, frame_height : Int32) -> Bool {
  if self.comp_prev.length() == 0 {
    self.rows >= frame_height
  } else {
    self.mcu_row >= self.mcu_rows
  }
}

///|
fn Scan::next_line_or_finish(self : Scan) -> Bool {
  if self.ilv == 0 && self.comp_prev.length() == 0 {
    self.last_row_comp = 0
    self.last_row_idx = self.rows
    self.total_rows += 1
    self.next_row()
    return true
  }
  let c = self.active_comp
  let line_y = if self.ilv == 2 {
    self.mcu_row
  } else {
    self.mcu_row * self.comp_v_samplings[c] + self.mcu_v_step
  }
  let is_real = line_y < self.comp_heights[c]
  if is_real {
    self.last_row_comp = c
    self.last_row_idx = self.comp_rows[c]
    let reusable = self.comp_prev[c]
    self.comp_prev_left[c] = reusable[0]
    self.comp_prev[c] = self.comp_curr[c]
    self.comp_curr[c] = reusable
    self.comp_rows[c] += 1
    self.total_rows += 1
  }
  if self.ilv == 1 {
    self.comp_run_index[c] = self.run_index
  }
  self.mcu_v_step += 1
  if self.ilv == 2 || self.mcu_v_step >= self.comp_v_samplings[c] {
    self.mcu_v_step = 0
    self.active_comp += 1
    if self.active_comp >= self.comp_indices.length() {
      self.active_comp = 0
      self.mcu_row += 1
    }
  }
  // In ILV=2 the whole row group is decoded before any component row is delivered.
  if self.ilv != 2 || self.active_comp == 0 {
    self.x = 0
  }
  if self.mcu_row < self.mcu_rows {
    self.select_component(self.active_comp)
    if self.ilv == 1 {
      self.run_index = self.comp_run_index[self.active_comp]
    }
  }
  is_real
}

///|
fn Scan::select_component(self : Scan, slot : Int32) -> Unit {
  self.active_comp = slot
  self.previous = self.comp_prev[slot]
  self.current = self.comp_curr[slot]
  self.previous_left = self.comp_prev_left[slot]
  self.active_width = self.comp_widths[slot]
}

///|
fn Scan::neighbors(self : Scan) -> (Int32, Int32, Int32, Int32) {
  let x = self.x
  let a = self.left()
  let b = self.previous[x]
  let c = if x == 0 { self.previous_left } else { self.previous[x - 1] }
  let d = self.previous[min(x + 1, self.active_width - 1)]
  (a, b, c, d)
}

///|
fn Scan::joint_run_context(self : Scan) -> Bool {
  // Called at a vector boundary. Scan each component's independent neighborhood.
  let mut joint = true
  for slot in 0..<self.comp_indices.length() {
    self.select_component(slot)
    let (a, b, c, d) = self.neighbors()
    if self.context_id(a, b, c, d) != 0 {
      joint = false
      break
    }
  }
  self.select_component(0)
  joint
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
  if self.ilv == 2 {
    let next = self.active_comp + 1
    if next < self.comp_indices.length() {
      self.select_component(next)
      return
    }
    self.select_component(0)
  }
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
fn golomb_order(a : UInt32, count : Int32) -> Int32 {
  let n = count.reinterpret_as_uint()
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
  let mut a = self.ctx_a[index] + abs_i32(error).reinterpret_as_uint()
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
  golomb_order(self.run_a[kind] + ((n >> 1) & (if kind != 0 { -1 } else { 0 })).reinterpret_as_uint(), n)
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
  let mut a = self.run_a[kind] + ((mapped + 1 - kind) >> 1).reinterpret_as_uint()
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
