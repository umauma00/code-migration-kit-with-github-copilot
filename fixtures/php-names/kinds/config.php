<?php
// A constant, a built-in function and a function named like a class are
// not that class (each class file includes this one: a false cycle).
define('PKDEBUG', true);
if (PKDEBUG) { error_reporting(E_ALL); }
function pk_stamp() { return date('Y-m-d'); }
function pkview($name) { return 'tpl/' . $name; }
function pk_render($n) { return pkview($n); }
