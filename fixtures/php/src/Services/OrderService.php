<?php
namespace App\Services;

use App\Models\Order;
use function strlen;

class OrderService {
    public function create(): Order {
        $fn = function () use ($x) { return \App\Models\Invoice::class; };
        return new Order();
    }
}
