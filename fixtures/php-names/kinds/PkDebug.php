<?php
require_once __DIR__ . '/config.php';
class PkDebug { public static function dump($x) { if (PKDEBUG) { var_dump($x); } } }
