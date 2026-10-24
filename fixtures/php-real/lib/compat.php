<?php
// A guarded polyfill with no unguarded copy: still the declaration.
if (!function_exists('mb_fallback')) { function mb_fallback() { return wp_sep(); } }
