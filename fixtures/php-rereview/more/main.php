<?php
class Sorter {
    function go($a, $s) {
        usort($a, static::$cmp);
        usort($a, static fn($x, $y) => 0);
        usort($a, [new SortFoo, 'cmp']);
        array_udiff($a, $b, 'cb_udiff');
        array_udiff_uassoc($a, $b, 'cb_val', 'cb_key');
        preg_replace_callback_array(['/x/' => 'cb_arr', '/y/' => $dyn], $s);
        register_activation_hook(__FILE__, 'cb_activate');
    }
}
