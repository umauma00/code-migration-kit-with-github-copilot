<?php
// A helper this script declares itself: no edge to script_b's copy.
function show_usage() { echo "a"; }
show_usage();
// LOCAL_TABLE is defined in two files; this script includes one of them.
require __DIR__ . '/consts.php';
echo LOCAL_TABLE;
