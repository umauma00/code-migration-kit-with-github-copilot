<?php
define('DS', DIRECTORY_SEPARATOR);
require_once __DIR__ . DIRECTORY_SEPARATOR . 'lib' . DIRECTORY_SEPARATOR . 'a.php';
require realpath(__DIR__ . '/lib/b.php');
require_once 'lib/c.php' or die('missing');
include(dirname(__FILE__) . DS . 'lib' . DS . 'd.php');
require_once $base . 'x.php';
