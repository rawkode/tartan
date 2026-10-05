package tartan

// String doubling: 2^30 bytes (1 GiB) after 30 steps, no builtin call.
_s0:  "x"
_s1:  _s0 + _s0
_s2:  _s1 + _s1
_s3:  _s2 + _s2
_s4:  _s3 + _s3
_s5:  _s4 + _s4
_s6:  _s5 + _s5
_s7:  _s6 + _s6
_s8:  _s7 + _s7
_s9:  _s8 + _s8
_s10: _s9 + _s9
_s11: _s10 + _s10
_s12: _s11 + _s11
_s13: _s12 + _s12
_s14: _s13 + _s13
_s15: _s14 + _s14
_s16: _s15 + _s15
_s17: _s16 + _s16
_s18: _s17 + _s17
_s19: _s18 + _s18
_s20: _s19 + _s19
_s21: _s20 + _s20
_s22: _s21 + _s21
_s23: _s22 + _s22
_s24: _s23 + _s23
_s25: _s24 + _s24
_s26: _s25 + _s25
_s27: _s26 + _s26
_s28: _s27 + _s27
_s29: _s28 + _s28
_s30: _s29 + _s29

extensions: "acme.no-secrets": settings: allow: [_s30]
