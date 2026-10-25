<?php
include __DIR__ . '/optional.php' or fallback();
require_once 'req.php' or die('missing');
(include 'opt2.php') OR fallback2();
