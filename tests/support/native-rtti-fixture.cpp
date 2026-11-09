struct Base { virtual ~Base() {} };
struct Left : Base {};
struct Right { virtual ~Right() {} };
struct Multi : Left, Right {};
struct Hidden : private Left, Right { Base* base() { return this; } Left* left() { return this; } };
struct VirtualLeft : virtual Base {};
struct VirtualRight : virtual Base {};
struct Diamond : VirtualLeft, VirtualRight {};
struct WrapperLeft : VirtualLeft {};
struct WrapperRight : VirtualLeft {};
struct Ambiguous : WrapperLeft, WrapperRight {};
struct RepeatRight : Base {};
struct Repeated : Left, RepeatRight {};

extern "C" int probe() {
 int result = 0;
 Multi multi; Base* base = &multi; Right* right = &multi;
 if (dynamic_cast<Multi*>(base) == &multi) result |= 1;
 if (dynamic_cast<Left*>(right) == static_cast<Left*>(&multi)) result |= 2;
 if (dynamic_cast<Right*>(base) == right) result |= 4;
 Hidden hidden;
 if (dynamic_cast<Hidden*>(hidden.base()) == nullptr) result |= 8;
 if (dynamic_cast<Right*>(hidden.base()) == nullptr) result |= 16;
 if (dynamic_cast<Left*>(hidden.base()) == hidden.left()) result |= 32;
 Diamond diamond; Base* virtualBase = &diamond;
 if (dynamic_cast<Diamond*>(virtualBase) == &diamond) result |= 64;
 if (dynamic_cast<VirtualLeft*>(virtualBase) == static_cast<VirtualLeft*>(&diamond)) result |= 128;
 Ambiguous ambiguous; Base* ambiguousBase = &ambiguous;
 if (dynamic_cast<VirtualLeft*>(ambiguousBase) == nullptr) result |= 256;
 Repeated repeated; Base* repeatedBase = static_cast<RepeatRight*>(&repeated);
 if (dynamic_cast<Repeated*>(repeatedBase) == &repeated) result |= 512;
 return result;
}

#ifdef NATIVE
extern "C" int printf(const char*, ...);
int main() { const int result = probe(); printf("%d\n", result); return result == 1023 ? 0 : 1; }
#endif
