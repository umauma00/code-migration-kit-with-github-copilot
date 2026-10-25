<?php
call_user_func("strtolower", "business");
add_action('init', 'business_init');
usort($rows, 'business_cmp');
array_map($this->mapper, $rows);
