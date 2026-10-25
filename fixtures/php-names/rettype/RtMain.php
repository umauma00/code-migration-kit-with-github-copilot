<?php
// A return type, nullable or union, and a union parameter type name the
// class even where a constant has the same name.
function rt_create(): RtResult { throw new Exception(); }
function rt_maybe(): ?RtMaybe { return null; }
$f = fn(RtLeft|RtRight $x): RtLeft|RtRight => $x;
// The else branch of a ternary is a value: the constant.
$v = $ok ? rt_create() : RT_FLAG;
