<?php
namespace App\Models;

class Customer {
    public function orders(): array { return [new Order()]; }
}
