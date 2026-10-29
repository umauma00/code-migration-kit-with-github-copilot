<?php
if (!include_once('inc/t1.php')) { f2(); }
if (include 'inc/t2.php') { new C3; }
while (require_once(__DIR__ . '/inc/t3.php') === false) { f2(); }
$x = [include 'inc/t4.php', f2()];
foo(require('inc/t5.php'), f2());
$y = include_once 'inc/t6.php' or die('x');
