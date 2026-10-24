<?php
// Two polyfills guarded by function_exists do not depend on each other.
if (!function_exists('str_x')) { function str_x() { return 1; } }
