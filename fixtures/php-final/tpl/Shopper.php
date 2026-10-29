<?php
// Quoted keys and arguments inside holes are text, and ${Order} is the
// variable $Order: no edge to Order.php (that would be a false cycle).
class Shopper {
    function label($a) { return "{$a["Order"]} {$this->t('Order')} ${Order}"; }
}
