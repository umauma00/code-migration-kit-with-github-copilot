<?php
namespace App\Models;

class Order {
    /** @var Customer */
    private $customer;
    public function customer(): Customer { return $this->customer; }
}
