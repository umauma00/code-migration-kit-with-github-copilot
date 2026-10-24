<?php
require __DIR__ . '/boot.php';
function run_expr($suffix) {
    call_user_func('handle_' . $suffix);
    call_user_func_array(get_callback(), []);
    call_user_func(callback: 'handler');
    array_map(array: $a, callback: 'mapper');
    usort($rows, 'cmp');
    array_map(function ($x) { return $x; }, $a);
    array_map(strlen(...), $a);
    array_map([$this, 'm'], $a);
    call_user_func('strtolower', 'business');
    add_action('init', 'on_init');
    if (is_a($x, 'Klass')) {}
}
