<?php
// String callables name a function or class that is never called directly.
array_map('my_cb', [1]);
usort($rows, ['Sorter', 'cmp']);
