<?php
namespace Atr\Meta;
#[\Attribute]
class AtCache { public function __construct(public int $ttl = 0) {} }
