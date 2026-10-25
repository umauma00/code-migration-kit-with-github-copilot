<?php
require_once __DIR__ . '/config.php';
class PkView { public function show($n) { return pk_render($n); } }
