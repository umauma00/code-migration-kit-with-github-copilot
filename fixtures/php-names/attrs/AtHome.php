<?php
namespace Atr;
// Attributes with arguments name their classes; the "(" is not a call.
class AtHome {
    #[AtRoute('/home')]
    public function index() { return 1; }
    #[AtGuard('admin'), \Atr\Meta\AtCache(ttl: 60)]
    public function admin() { return 2; }
}
