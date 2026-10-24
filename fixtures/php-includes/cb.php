<?php
// String callables name a function or class that is never called directly.
array_map('my_cb', [1]);
usort($rows, ['Sorter', 'cmp']);
// A namespaced function named by its full name in a string.
array_map('App\Util\conv', [1]);
