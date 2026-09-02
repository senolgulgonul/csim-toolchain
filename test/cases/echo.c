#include <stdio.h>
int main(void) {
    int a, b;
    char name[32];
    if (scanf("%31s %d %d", name, &a, &b) != 3) { printf("input error\n"); return 1; }
    printf("Hi %s, %d + %d = %d\n", name, a, b, a + b);
    return 0;
}
