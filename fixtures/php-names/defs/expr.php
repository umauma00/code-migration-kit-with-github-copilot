<?php
if ($x) { define('P', __DIR__ . '/a/boot.php'); } else { define('P', __DIR__ . '/b/boot.php'); }
include P;
