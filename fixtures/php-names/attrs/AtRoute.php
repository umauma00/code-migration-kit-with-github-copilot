<?php
namespace Atr;
#[\Attribute(\Attribute::TARGET_METHOD)]
class AtRoute { public function __construct(public string $path = '/') {} }
