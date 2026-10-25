<?php
namespace Atr;
#[\Attribute]
class AtGuard { public function __construct(public string $role = '') {} }
