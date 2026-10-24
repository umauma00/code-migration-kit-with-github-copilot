<?php
require "inc.php";
call_user_func($cb);
call_user_func_array($cb, []);
$cb();
