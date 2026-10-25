<?php
if ($env) { define('BASE', 'a'); }
else { define('BASE', 'b'); }
include BASE . '/boot.php';
