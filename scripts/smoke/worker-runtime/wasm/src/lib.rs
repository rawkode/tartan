//! Tiny no-deps wasm module for the Tartan runtime smoke tests.
//! Exports: add(i32,i32)->i32, alloc(len)->ptr, dealloc(ptr,len),
//! transform(ptr,len)->u64 (packed ptr<<32|len) : JSON-in -> JSON-out
//! (input bytes are echoed back wrapped with a length and a byte checksum; no serde to keep it tiny).

#[no_mangle]
pub extern "C" fn add(a: i32, b: i32) -> i32 { a.wrapping_add(b) }

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
pub unsafe extern "C" fn transform(ptr: *const u8, len: usize) -> u64 {
    let input = core::slice::from_raw_parts(ptr, len);
    let sum: u32 = input.iter().map(|b| *b as u32).sum();
    let mut out = Vec::new();
    out.extend_from_slice(b"{\"from\":\"rust\",\"len\":");
    out.extend_from_slice(len.to_string().as_bytes());
    out.extend_from_slice(b",\"checksum\":");
    out.extend_from_slice(sum.to_string().as_bytes());
    out.extend_from_slice(b",\"input\":");
    out.extend_from_slice(input);
    out.push(b'}');
    let out_len = out.len();
    let out_ptr = out.as_mut_ptr();
    core::mem::forget(out);
    ((out_ptr as u64) << 32) | out_len as u64
}
